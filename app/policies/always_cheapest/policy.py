from app.policies.base import RouterPolicy
from app.policies.selection import choose_best, numeric_metric
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext


class AlwaysCheapestPolicy(RouterPolicy):
    name = "always-cheapest"
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
        selected = choose_best(candidates, key=self._estimated_token_cost, reverse=False)
        return RoutePlan(
            mode="single",
            selected_model=selected.id,
            fallback_models=[],
            confidence=1.0,
            policy_name=self.name,
            policy_version=self.version,
            metadata={"reason": "lowest_estimated_token_cost"},
        )

    @staticmethod
    def _estimated_token_cost(model: ModelProfile) -> float:
        input_cost = numeric_metric(model, ("cost", "input_per_million"), 1_000_000.0)
        output_cost = numeric_metric(model, ("cost", "output_per_million"), 1_000_000.0)
        return input_cost + output_cost
