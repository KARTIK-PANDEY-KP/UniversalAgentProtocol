import pytest
from pydantic import ValidationError

from app.policies.base import RouterPolicy
from app.protocol import (
    FeedbackEvent,
    ModelProfile,
    RoutePlan,
    RouterRequest,
    RouteStep,
    RoutingBudget,
    RoutingContext,
)


def test_router_request_validates_minimum_shape() -> None:
    request = RouterRequest(
        request_id="req_123",
        public_model="brainbase-chat",
        messages=[{"role": "user", "content": "Hello"}],
    )

    assert request.modality == "text"
    assert request.metadata == {}


def test_model_profile_validates_minimum_shape() -> None:
    profile = ModelProfile(
        id="openrouter:openai/gpt-4o-mini",
        executor="portkey",
        executor_model="@openrouter/openai/gpt-4o-mini",
        provider="openrouter",
        status="enabled",
        supports={"tools": True},
        limits={"context_window": 128000},
        cost={"input_per_million": 0.15},
        capabilities={"overall": 0.7},
    )

    assert profile.executor_model == "@openrouter/openai/gpt-4o-mini"


def test_single_route_plan_requires_selected_model() -> None:
    with pytest.raises(ValidationError, match="selected_model is required"):
        RoutePlan(mode="single", policy_name="always-strongest", policy_version="v0")


def test_cascade_route_plan_requires_steps() -> None:
    with pytest.raises(ValidationError, match="steps are required"):
        RoutePlan(mode="cascade", policy_name="manual-rules", policy_version="v0")


def test_route_plan_requires_policy_identity() -> None:
    with pytest.raises(ValidationError):
        RoutePlan(mode="single", selected_model="openrouter:openai/gpt-4o-mini", policy_name="")


def test_valid_single_route_plan() -> None:
    plan = RoutePlan(
        mode="single",
        selected_model="openrouter:openai/gpt-4o-mini",
        fallback_models=["openrouter:anthropic/claude-3-haiku"],
        confidence=0.9,
        policy_name="always-strongest",
        policy_version="v0",
    )

    assert plan.selected_model == "openrouter:openai/gpt-4o-mini"
    assert plan.fallback_models == ["openrouter:anthropic/claude-3-haiku"]


def test_valid_cascade_route_plan() -> None:
    plan = RoutePlan(
        mode="cascade",
        steps=[RouteStep(model="openrouter:openai/gpt-4o-mini", condition="try_first")],
        policy_name="manual-rules",
        policy_version="v0",
    )

    assert plan.steps[0].condition == "try_first"


def test_routing_budget_and_context_defaults_are_isolated() -> None:
    first_context = RoutingContext()
    second_context = RoutingContext()
    first_context.policy_config["x"] = "y"

    assert second_context.policy_config == {}
    assert RoutingBudget().max_cascade_depth == 1


def test_feedback_event_accepts_optional_outcomes() -> None:
    event = FeedbackEvent(request_id="req_123", quality_score=0.8, workflow_success=True)

    assert event.workflow_success is True


def test_router_policy_is_abstract() -> None:
    with pytest.raises(TypeError):
        RouterPolicy()
