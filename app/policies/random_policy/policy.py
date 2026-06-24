import random

from app.policies.base import RouterPolicy
from app.policies.selection import require_candidates
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext


class RandomPolicy(RouterPolicy):
    name = "random"
    version = "v0"
    supported_modes = ["single"]

    def __init__(self, seed: int = 0) -> None:
        self._rng = random.Random(seed)

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del request, context, budget
        selected = self._rng.choice(require_candidates(candidates))
        return RoutePlan(
            mode="single",
            selected_model=selected.id,
            fallback_models=[],
            confidence=0.5,
            policy_name=self.name,
            policy_version=self.version,
            metadata={"reason": "seeded_random_baseline"},
        )
