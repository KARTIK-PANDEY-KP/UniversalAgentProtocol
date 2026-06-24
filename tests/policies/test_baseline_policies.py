import pytest

from app.policies import (
    AlwaysCheapestPolicy,
    AlwaysFastestPolicy,
    AlwaysStrongestPolicy,
    ManualRulesPolicy,
    RandomPolicy,
)
from app.policies.errors import PolicyError
from app.protocol import ModelProfile, RouterRequest, RoutingBudget, RoutingContext


def model(
    model_id: str,
    *,
    status: str = "enabled",
    overall: float,
    cost: float,
    latency: float,
    coding: float = 0.0,
    tool_use: float = 0.0,
) -> ModelProfile:
    return ModelProfile(
        id=model_id,
        executor="portkey",
        executor_model=f"@{model_id.replace(':', '/')}",
        provider="openrouter",
        status=status,
        supports={"tools": True, "vision": False, "json": True},
        limits={"context_window": 128000},
        cost={"input_per_million": cost, "output_per_million": cost},
        capabilities={
            "overall": overall,
            "latency_score": latency,
            "coding": coding,
            "tool_use": tool_use,
        },
    )


def request(public_model: str = "brainbase-chat") -> RouterRequest:
    return RouterRequest(
        request_id="req_123",
        public_model=public_model,
        messages=[{"role": "user", "content": "hello"}],
    )


def candidates() -> list[ModelProfile]:
    return [
        model("openrouter:cheap/fast", overall=0.4, cost=0.1, latency=0.9, coding=0.4),
        model("openrouter:strong/model", overall=0.95, cost=5.0, latency=0.4, coding=0.9),
        model("openrouter:agent/model", overall=0.7, cost=1.0, latency=0.5, tool_use=0.95),
    ]


def test_always_strongest_selects_highest_overall() -> None:
    plan = AlwaysStrongestPolicy().plan(request(), candidates(), RoutingContext(), RoutingBudget())

    assert plan.selected_model == "openrouter:strong/model"
    assert plan.policy_name == "always-strongest"
    assert plan.policy_version == "v0"


def test_always_cheapest_selects_lowest_cost() -> None:
    plan = AlwaysCheapestPolicy().plan(request(), candidates(), RoutingContext(), RoutingBudget())

    assert plan.selected_model == "openrouter:cheap/fast"


def test_always_fastest_selects_highest_latency_score() -> None:
    plan = AlwaysFastestPolicy().plan(request(), candidates(), RoutingContext(), RoutingBudget())

    assert plan.selected_model == "openrouter:cheap/fast"


def test_manual_rules_selects_coding_model_for_code() -> None:
    plan = ManualRulesPolicy().plan(
        request("brainbase-code"),
        candidates(),
        RoutingContext(),
        RoutingBudget(mode="code"),
    )

    assert plan.selected_model == "openrouter:strong/model"
    assert plan.metadata["capability"] == "coding"


def test_manual_rules_selects_agent_step_mode_for_agent() -> None:
    plan = ManualRulesPolicy().plan(
        request("brainbase-agent"),
        candidates(),
        RoutingContext(),
        RoutingBudget(mode="agent"),
    )

    assert plan.mode == "agent_step"
    assert plan.selected_model == "openrouter:agent/model"


def test_random_policy_returns_valid_plan() -> None:
    plan = RandomPolicy(seed=1).plan(request(), candidates(), RoutingContext(), RoutingBudget())

    assert plan.selected_model is not None
    assert plan.policy_name == "random"


def test_disabled_candidates_are_ignored() -> None:
    disabled_best = model(
        "openrouter:disabled/best",
        status="disabled",
        overall=1.0,
        cost=0.01,
        latency=1.0,
    )
    plan = AlwaysStrongestPolicy().plan(
        request(),
        [disabled_best, *candidates()],
        RoutingContext(),
        RoutingBudget(),
    )

    assert plan.selected_model != "openrouter:disabled/best"


def test_empty_candidate_list_raises() -> None:
    with pytest.raises(PolicyError):
        AlwaysStrongestPolicy().plan(request(), [], RoutingContext(), RoutingBudget())
