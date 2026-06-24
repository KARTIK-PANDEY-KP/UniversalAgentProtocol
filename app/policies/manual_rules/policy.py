from typing import Literal

from app.policies.base import RouterPolicy
from app.policies.selection import choose_best, numeric_metric
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
        selected = choose_best(
            candidates,
            key=lambda model: numeric_metric(model, ("capabilities", capability), 0.0),
        )
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
