from typing import Literal

from app.policies.base import RouterPolicy
from app.policies.selection import choose_best, numeric_metric, require_candidates
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext


class ManualRulesPolicy(RouterPolicy):
    name = "manual-rules"
    version = "v0"
    supported_modes = ["single", "agent_step"]

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del context
        capability = self._capability_for(request.public_model, budget.mode)
        selected = self._select_model(candidates, capability, budget.mode)
        mode: Literal["agent_step", "single"] = "agent_step" if budget.mode == "agent" else "single"
        return RoutePlan(
            mode=mode,
            selected_model=selected.id,
            fallback_models=[],
            confidence=0.85,
            policy_name=self.name,
            policy_version=self.version,
            metadata={"reason": "manual_capability_rule", "capability": capability},
        )

    @staticmethod
    def _capability_for(public_model: str, mode: str) -> str:
        if public_model == "brainbase-code" or mode == "code":
            return "coding"
        if public_model == "brainbase-agent" or mode == "agent":
            return "tool_use"
        if public_model == "brainbase-fast" or mode == "fast":
            return "latency_score"
        return "overall"

    @classmethod
    def _select_model(
        cls,
        candidates: list[ModelProfile],
        capability: str,
        mode: str,
    ) -> ModelProfile:
        if mode in {"best", "premium"}:
            return choose_best(
                candidates,
                key=lambda model: numeric_metric(model, ("capabilities", capability), 0.0),
            )
        available = require_candidates(candidates)
        top_score = max(
            numeric_metric(model, ("capabilities", capability), 0.0) for model in available
        )
        # Prefer cheaper models that clear a capability floor; premium/best still choose strongest.
        capability_floor = max(0.0, top_score * 0.75)
        good_enough = [
            model
            for model in available
            if numeric_metric(model, ("capabilities", capability), 0.0) >= capability_floor
        ]
        return min(good_enough, key=cls._estimated_token_cost)

    @staticmethod
    def _estimated_token_cost(model: ModelProfile) -> float:
        input_cost = numeric_metric(model, ("cost", "input_per_million"), 1_000_000.0)
        output_cost = numeric_metric(model, ("cost", "output_per_million"), 1_000_000.0)
        return input_cost + output_cost
