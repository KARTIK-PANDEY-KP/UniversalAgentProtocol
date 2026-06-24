from typing import Any

from app.config import Settings
from app.executor.execution_result import ExecutionResult
from app.executor.fallback_executor import FallbackExecutor
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
from app.storage.trace_repository import MemoryTraceRepository, TraceRepository


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
        return cls(
            model_registry=ModelRegistry.from_yaml(),
            policy_registry=PolicyRegistry.from_yaml(),
            tenant_registry=TenantRegistry.from_yaml(),
            executor=build_executor(settings),
            trace_repository=MemoryTraceRepository(),
        )

    def list_public_models(self) -> list[str]:
        return self._public_model_resolver.list_public_models()

    def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = normalize_chat_request(payload)
        alias = self._public_model_resolver.resolve(request.public_model)
        tenant_config = self._tenant_registry.tenant_config(request.tenant_id)
        budget = self._budget_from(alias, request.metadata.get("routing", {}))
        context = RoutingContext(
            tenant_config=tenant_config.model_dump(mode="json"),
            public_model_config=alias.model_dump(mode="json"),
            policy_config=alias.config,
        )
        candidates = self._candidate_resolver.candidates_for_pool(alias.model_pool)
        policy = self._policy_loader.load(alias.policy_name, alias.policy_version)
        try:
            plan = policy.plan(request, candidates, context, budget)
        except Exception:
            plan = self._fallback_plan(request, candidates, context, budget, alias)
        self._validator.validate(plan, request, candidates, alias, budget)
        result = FallbackExecutor(self._executor, self._model_registry.get).execute(
            plan,
            request.messages,
            tools=request.tools,
            response_format=request.response_format,
        )
        trace = self._trace_record(request, alias, plan, candidates, result)
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

    @staticmethod
    def _trace_record(
        request: RouterRequest,
        alias: PublicModelAlias,
        plan: RoutePlan,
        candidates: list[ModelProfile],
        result: ExecutionResult,
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
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost_usd=result.cost_usd,
            latency_ms=result.latency_ms,
            status="ok",
            error=None,
        )
