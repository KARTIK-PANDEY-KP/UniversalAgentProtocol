from typing import Any

import pytest

from app.executor.execution_result import ExecutionResult
from app.executor.mock_executor import MockExecutor
from app.executor.types import ChatExecutor
from app.policies.base import RouterPolicy
from app.protocol import ModelProfile, RoutePlan, RouterRequest, RoutingBudget, RoutingContext
from app.registries import ModelRegistry, PolicyRegistry, TenantRegistry
from app.runtime.errors import RoutePlanValidationError
from app.runtime.kernel import RuntimeKernel
from app.runtime.model_candidate_resolver import ModelCandidateResolver
from app.runtime.policy_loader import PolicyLoader
from app.runtime.public_model_resolver import PublicModelResolver
from app.runtime.request_normalizer import normalize_chat_request
from app.runtime.route_plan_validator import RoutePlanValidator
from app.storage.trace_repository import MemoryTraceRepository


def make_kernel(executor: ChatExecutor | None = None) -> RuntimeKernel:
    return RuntimeKernel(
        model_registry=ModelRegistry.from_yaml(),
        policy_registry=PolicyRegistry.from_yaml(),
        tenant_registry=TenantRegistry.from_yaml(),
        executor=executor or MockExecutor(),
        trace_repository=MemoryTraceRepository(),
    )


def test_request_normalization() -> None:
    request = normalize_chat_request(
        {
            "model": "brainbase-chat",
            "messages": [{"role": "user", "content": "hello"}],
            "routing": {"debug": True},
        }
    )

    assert request.public_model == "brainbase-chat"
    assert request.metadata["routing"]["debug"] is True


def test_public_model_alias_resolution() -> None:
    resolver = PublicModelResolver(TenantRegistry.from_yaml())

    assert resolver.resolve("brainbase-code").model_pool == "coding"


def test_candidate_model_resolution() -> None:
    candidates = ModelCandidateResolver(ModelRegistry.from_yaml()).candidates_for_pool("coding")

    assert candidates
    assert all(candidate.status == "enabled" for candidate in candidates)


def test_policy_loading() -> None:
    policy = PolicyLoader(PolicyRegistry.from_yaml()).load("always-strongest", "v0")

    assert policy.name == "always-strongest"


def test_valid_route_plan_passes_validator() -> None:
    model_registry = ModelRegistry.from_yaml()
    tenant_registry = TenantRegistry.from_yaml()
    alias = tenant_registry.resolve_public_model("brainbase-chat")
    candidates = model_registry.candidates_for_pool(alias.model_pool)
    plan = RoutePlan(
        mode="single",
        selected_model=candidates[0].id,
        policy_name=alias.policy_name,
        policy_version=alias.policy_version,
    )
    request = RouterRequest(
        request_id="req_123",
        public_model="brainbase-chat",
        messages=[{"role": "user", "content": "hello"}],
    )

    RoutePlanValidator().validate(plan, request, candidates, alias, RoutingBudget())


def test_invalid_selected_model_fails_validation() -> None:
    tenant_registry = TenantRegistry.from_yaml()
    alias = tenant_registry.resolve_public_model("brainbase-chat")
    request = RouterRequest(
        request_id="req_123",
        public_model="brainbase-chat",
        messages=[{"role": "user", "content": "hello"}],
    )
    plan = RoutePlan(
        mode="single",
        selected_model="openrouter:missing/model",
        policy_name=alias.policy_name,
        policy_version=alias.policy_version,
    )

    with pytest.raises(RoutePlanValidationError):
        RoutePlanValidator().validate(plan, request, [], alias, RoutingBudget())


def test_disabled_model_fails_validation() -> None:
    tenant_registry = TenantRegistry.from_yaml()
    alias = tenant_registry.resolve_public_model("brainbase-chat")
    disabled = ModelProfile(
        id="openrouter:disabled/model",
        executor="portkey",
        executor_model="@openrouter/disabled/model",
        provider="openrouter",
        status="disabled",
        supports={"tools": True, "json": True},
        limits={"context_window": 1000},
        cost={},
        capabilities={},
    )
    plan = RoutePlan(
        mode="single",
        selected_model=disabled.id,
        policy_name=alias.policy_name,
        policy_version=alias.policy_version,
    )
    request = RouterRequest(
        request_id="req_123",
        public_model="brainbase-chat",
        messages=[{"role": "user", "content": "hello"}],
    )

    with pytest.raises(RoutePlanValidationError, match="disabled"):
        RoutePlanValidator().validate(plan, request, [disabled], alias, RoutingBudget())


def test_unsupported_tools_and_json_fail_validation() -> None:
    tenant_registry = TenantRegistry.from_yaml()
    alias = tenant_registry.resolve_public_model("brainbase-chat")
    unsupported = ModelProfile(
        id="openrouter:limited/model",
        executor="portkey",
        executor_model="@openrouter/limited/model",
        provider="openrouter",
        status="enabled",
        supports={"tools": False, "json": False},
        limits={"context_window": 1000},
        cost={},
        capabilities={},
    )
    plan = RoutePlan(
        mode="single",
        selected_model=unsupported.id,
        policy_name=alias.policy_name,
        policy_version=alias.policy_version,
    )
    request = RouterRequest(
        request_id="req_123",
        public_model="brainbase-chat",
        messages=[{"role": "user", "content": "hello"}],
        tools=[{"type": "function"}],
        response_format={"type": "json_object"},
    )

    with pytest.raises(RoutePlanValidationError):
        RoutePlanValidator().validate(plan, request, [unsupported], alias, RoutingBudget())


def test_runtime_end_to_end_mock_executor_creates_trace() -> None:
    kernel = make_kernel()
    response = kernel.chat_completion(
        {
            "model": "brainbase-chat",
            "messages": [{"role": "user", "content": "hello"}],
        }
    )

    assert response["model"] == "brainbase-chat"
    traces = kernel.trace_repository.list_traces()
    assert len(traces) == 1
    assert traces[0].public_model == "brainbase-chat"


class BadPolicy(RouterPolicy):
    name = "manual-rules"
    version = "v0"
    supported_modes = ["single"]

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del request, candidates, context, budget
        raise RuntimeError("policy failed")


class BadPolicyLoader:
    def load(self, name: str, version: str) -> RouterPolicy:
        del name, version
        return BadPolicy()


def test_fallback_policy_used_when_active_policy_throws() -> None:
    kernel = make_kernel()
    kernel._policy_loader = BadPolicyLoader()  # noqa: SLF001

    response = kernel.chat_completion(
        {
            "model": "brainbase-chat",
            "messages": [{"role": "user", "content": "hello"}],
        }
    )

    assert response["model"] == "brainbase-chat"
    trace = kernel.trace_repository.list_traces()[0]
    assert trace.policy_name == "manual-rules"


class CountingExecutor(ChatExecutor):
    def __init__(self) -> None:
        self.calls = 0

    def execute(
        self,
        model: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        del model, messages, tools, response_format
        self.calls += 1
        return ExecutionResult(content="should not happen", model="mock")


class InvalidPlanPolicy(RouterPolicy):
    name = "manual-rules"
    version = "v0"
    supported_modes = ["single"]

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del request, candidates, context, budget
        return RoutePlan(
            mode="single",
            selected_model="openrouter:not/in-pool",
            policy_name="manual-rules",
            policy_version="v0",
        )


class InvalidPolicyLoader:
    def load(self, name: str, version: str) -> RouterPolicy:
        del name, version
        return InvalidPlanPolicy()


def test_invalid_route_plan_does_not_execute() -> None:
    executor = CountingExecutor()
    kernel = make_kernel(executor=executor)
    kernel._policy_loader = InvalidPolicyLoader()  # noqa: SLF001

    with pytest.raises(RoutePlanValidationError):
        kernel.chat_completion(
            {
                "model": "brainbase-chat",
                "messages": [{"role": "user", "content": "hello"}],
            }
        )

    assert executor.calls == 0
