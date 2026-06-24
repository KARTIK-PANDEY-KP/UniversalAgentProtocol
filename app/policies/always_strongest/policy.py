from app.policies.base import RouterPolicy
from app.policies.selection import choose_best, numeric_metric
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext


class AlwaysStrongestPolicy(RouterPolicy):
    name = "always-strongest"
    version = "v0"
    supported_modes = ["single"]

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del request, context, budget
        selected = choose_best(
            candidates,
            key=lambda model: numeric_metric(model, ("capabilities", "overall"), 0.0),
        )
        return RoutePlan(
            mode="single",
            selected_model=selected.id,
            fallback_models=[],
            confidence=1.0,
            policy_name=self.name,
            policy_version=self.version,
            metadata={"reason": "highest_overall_capability"},
        )
