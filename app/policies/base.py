from abc import ABC, abstractmethod

from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext


class RouterPolicy(ABC):
    name: str
    version: str
    supported_modes: list[str]

    @abstractmethod
    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        """Return a RoutePlan without performing provider, storage, or HTTP side effects."""
