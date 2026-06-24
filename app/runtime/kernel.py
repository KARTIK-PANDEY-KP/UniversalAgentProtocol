from typing import Any

from app.config import Settings
from app.executor.execution_result import ExecutionResult
from app.executor.fallback_executor import FallbackExecutor
from app.executor.openrouter_model_resolver import resolve_openrouter_executor_model
from app.executor.types import ChatExecutor
from app.policies.always_strongest import AlwaysStrongestPolicy
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext
from app.registries.model_registry import ModelRegistry
from app.registries.policy_registry import PolicyRegistry
from app.registries.schemas import PublicModelAlias
from app.registries.tenant_registry import TenantRegistry
from app.runtime.executor_factory import build_executor
from app.runtime.model_candidate_resolver import ModelCandidateResolver
from app.runtime.policy_loader import PolicyLoader
from app.runtime.public_model_resolver import PublicModelResolver
from app.runtime.request_normalizer import normalize_chat_request
from app.runtime.response_normalizer import ResponseNormalizer
from app.runtime.route_plan_validator import RoutePlanValidator
from app.storage.schemas import TraceRecord
from app.storage.supabase_client import SupabaseClient
from app.storage.trace_repository import (
    MemoryTraceRepository,
    SupabaseTraceRepository,
    TraceRepository,
)


class RuntimeKernel:
    def __init__(
        self,
        model_registry: ModelRegistry,
        policy_registry: PolicyRegistry,
        tenant_registry: TenantRegistry,
        executor: ChatExecutor,
        trace_repository: TraceRepository | None = None,
    ) -> None:
        self._model_registry = model_registry
        self._tenant_registry = tenant_registry
        self._public_model_resolver = PublicModelResolver(tenant_registry)
        self._candidate_resolver = ModelCandidateResolver(model_registry)
        self._policy_loader = PolicyLoader(policy_registry)
        self._validator = RoutePlanValidator()
        self._executor = executor
        self._trace_repository = trace_repository or MemoryTraceRepository()
        self._response_normalizer = ResponseNormalizer()

    @classmethod
    def from_settings(cls, settings: Settings) -> "RuntimeKernel":
        supabase_client: SupabaseClient | None = None
        if settings.storage_mode == "supabase" or settings.registry_mode == "supabase":
            supabase_client = SupabaseClient.from_settings(settings)

        model_registry: ModelRegistry
        policy_registry: PolicyRegistry
        tenant_registry: TenantRegistry
        if settings.registry_mode == "supabase":
            if supabase_client is None:
                raise ValueError("Supabase registry mode requires Supabase settings")
            model_registry = ModelRegistry.from_supabase(supabase_client)
            policy_registry = PolicyRegistry.from_supabase(supabase_client)
            tenant_registry = TenantRegistry.from_supabase(supabase_client)
        else:
            model_registry = ModelRegistry.from_yaml()
            policy_registry = PolicyRegistry.from_yaml()
            tenant_registry = TenantRegistry.from_yaml()

        trace_repository: TraceRepository
        if settings.storage_mode == "supabase":
            if supabase_client is None:
                raise ValueError("Supabase storage mode requires Supabase settings")
            trace_repository = SupabaseTraceRepository(supabase_client)
        else:
            trace_repository = MemoryTraceRepository()
        return cls(
            model_registry=model_registry,
            policy_registry=policy_registry,
            tenant_registry=tenant_registry,
            executor=build_executor(settings),
            trace_repository=trace_repository,
        )

    def list_public_models(self) -> list[str]:
        return self._public_model_resolver.list_public_models()

    def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = normalize_chat_request(payload)
        alias = self._public_model_resolver.resolve(request.public_model)
        tenant_config = self._tenant_registry.tenant_config(request.tenant_id)
        routing_options = request.metadata.get("routing", {})
        budget = self._budget_from(alias, routing_options)
        context = RoutingContext(
            tenant_config=tenant_config.model_dump(mode="json"),
            public_model_config=alias.model_dump(mode="json"),
            policy_config=alias.config,
        )
        candidates = self._candidate_resolver.candidates_for_pool(alias.model_pool)
        dynamic_plan = self._dynamic_passthrough_plan(request, alias, candidates, routing_options)
        if dynamic_plan is not None:
            plan = dynamic_plan
        else:
            policy = self._policy_loader.load(alias.policy_name, alias.policy_version)
            try:
                plan = policy.plan(request, candidates, context, budget)
            except Exception:
                plan = self._fallback_plan(request, candidates, context, budget, alias)
        self._validator.validate(plan, request, candidates, alias, budget)
        shadow_plan = self._shadow_plan(
            request, alias, candidates, context, budget, routing_options
        )
        result = FallbackExecutor(self._executor, self._model_registry.get).execute(
            plan,
            request.messages,
            tools=request.tools,
            response_format=request.response_format,
        )
        trace = self._trace_record(
            request=request,
            alias=alias,
            plan=plan,
            candidates=candidates,
            result=result,
            budget=budget,
            context=context,
            shadow_plan=shadow_plan,
        )
        self._trace_repository.insert_trace(trace)
        return self._response_normalizer.normalize(request, result, plan)

    @property
    def trace_repository(self) -> TraceRepository:
        return self._trace_repository

    @staticmethod
    def _budget_from(alias: PublicModelAlias, routing: object) -> RoutingBudget:
        routing_options = routing if isinstance(routing, dict) else {}
        return RoutingBudget(
            max_cost_usd=routing_options.get("max_cost_usd"),
            max_latency_ms=routing_options.get("latency_budget_ms"),
            max_cascade_depth=int(routing_options.get("max_cascade_depth", 1)),
            allow_multi_call=bool(routing_options.get("allow_multi_call", False)),
            allow_expensive_models=bool(alias.config.get("allow_expensive_models", False)),
            mode=str(routing_options.get("mode", alias.mode)),
        )

    @staticmethod
    def _fallback_plan(
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
        alias: PublicModelAlias,
    ) -> RoutePlan:
        plan = AlwaysStrongestPolicy().plan(request, candidates, context, budget)
        return plan.model_copy(
            update={"policy_name": alias.policy_name, "policy_version": alias.policy_version}
        )

    def _dynamic_passthrough_plan(
        self,
        request: RouterRequest,
        alias: PublicModelAlias,
        candidates: list[ModelProfile],
        routing: object,
    ) -> RoutePlan | None:
        if not isinstance(routing, dict):
            return None
        forced_model = routing.get("force_model")
        debug_enabled = routing.get("debug") is True or routing.get("test_mode") is True
        if not isinstance(forced_model, str) or not debug_enabled:
            return None
        executor_model = resolve_openrouter_executor_model(forced_model)
        try:
            model = self._model_registry.get(forced_model)
        except Exception:
            model = ModelProfile(
                id=forced_model,
                executor="portkey",
                executor_model=executor_model,
                provider="openrouter",
                status="enabled",
                supports={"tools": True, "vision": True, "json": True, "streaming": True},
                limits={"context_window": 128000},
                cost={"input_per_million": 0.0, "output_per_million": 0.0},
                capabilities={"overall": 0.0, "latency_score": 0.0},
                metadata={"dynamic_passthrough": True, "model_pools": [alias.model_pool]},
            )
            self._model_registry.add_model(model, [alias.model_pool])
        if model.id not in [candidate.id for candidate in candidates]:
            candidates.append(model)
        return RoutePlan(
            mode="single",
            selected_model=model.id,
            policy_name=alias.policy_name,
            policy_version=alias.policy_version,
            metadata={"dynamic_passthrough": True, "unverified": True},
        )

    def _shadow_plan(
        self,
        request: RouterRequest,
        alias: PublicModelAlias,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
        routing: object,
    ) -> RoutePlan | None:
        shadow_policy_ref: object = alias.config.get("shadow_policy")
        if isinstance(routing, dict) and routing.get("shadow_policy"):
            shadow_policy_ref = routing["shadow_policy"]
        if not isinstance(shadow_policy_ref, str):
            return None
        name, _, version = shadow_policy_ref.partition(":")
        version = version or "v0"
        policy = self._policy_loader.load(name, version)
        shadow_alias = alias.model_copy(update={"policy_name": name, "policy_version": version})
        plan = policy.plan(request, candidates, context, budget)
        self._validator.validate(plan, request, candidates, shadow_alias, budget)
        return plan

    @staticmethod
    def _trace_record(
        request: RouterRequest,
        alias: PublicModelAlias,
        plan: RoutePlan,
        candidates: list[ModelProfile],
        result: ExecutionResult,
        budget: RoutingBudget,
        context: RoutingContext,
        shadow_plan: RoutePlan | None = None,
    ) -> TraceRecord:
        del alias
        return TraceRecord(
            request_id=request.request_id,
            public_model=request.public_model,
            tenant_id=request.tenant_id,
            policy_name=plan.policy_name,
            policy_version=plan.policy_version,
            route_plan=plan.model_dump(mode="json"),
            selected_model=plan.selected_model,
            candidate_models=[candidate.id for candidate in candidates],
            fallback_used=result.fallback_used,
            request_messages=request.messages,
            request_tools=request.tools,
            response_format=request.response_format,
            routing_budget=budget.model_dump(mode="json"),
            routing_context=context.model_dump(mode="json"),
            policy_metadata=plan.metadata,
            response_content=result.content,
            response_tool_calls=result.tool_calls,
            execution_metadata=result.raw_response,
            feedback_signals={
                "tool_success": None,
                "workflow_success": None,
                "user_feedback": None,
            },
            training_labels={
                "selected_model": plan.selected_model,
                "fallback_used": result.fallback_used,
                "status": "ok",
            },
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost_usd=result.cost_usd,
            latency_ms=result.latency_ms,
            status="ok",
            error=None,
            shadow_plan=shadow_plan.model_dump(mode="json") if shadow_plan else None,
            shadow_policy=(
                f"{shadow_plan.policy_name}:{shadow_plan.policy_version}" if shadow_plan else None
            ),
            shadow_selected_model=shadow_plan.selected_model if shadow_plan else None,
        )
