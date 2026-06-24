from typing import Any

from app.executor.types import ChatExecutor
from app.policies.base import RouterPolicy
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext
from app.registries.model_registry import ModelRegistry
from app.registries.schemas import PublicModelAlias
from app.runtime.route_plan_validator import RoutePlanValidator


class ShadowRunner:
    def __init__(
        self,
        model_registry: ModelRegistry,
        executor: ChatExecutor,
        validator: RoutePlanValidator | None = None,
    ) -> None:
        self._model_registry = model_registry
        self._executor = executor
        self._validator = validator or RoutePlanValidator()

    def run_shadow(
        self,
        request: RouterRequest,
        alias: PublicModelAlias,
        live_policy: RouterPolicy,
        shadow_policy: RouterPolicy,
        execute_shadow: bool = False,
    ) -> dict[str, Any]:
        candidates = self._model_registry.candidates_for_pool(alias.model_pool)
        budget = RoutingBudget(mode=alias.mode)
        context = RoutingContext(public_model_config=alias.model_dump(mode="json"))
        live_plan = live_policy.plan(request, candidates, context, budget)
        self._validator.validate(live_plan, request, candidates, alias, budget)
        if live_plan.selected_model is None:
            raise RuntimeError("Live shadow run requires selected_model for MVP")
        live_result = self._executor.execute(
            self._model_registry.get(live_plan.selected_model),
            request.messages,
        )

        shadow_alias = alias.model_copy(
            update={"policy_name": shadow_policy.name, "policy_version": shadow_policy.version}
        )
        shadow_plan = shadow_policy.plan(request, candidates, context, budget)
        self._validator.validate(shadow_plan, request, candidates, shadow_alias, budget)
        shadow_result = None
        if execute_shadow:
            if shadow_plan.selected_model is None:
                raise RuntimeError("Shadow execution requires selected_model for MVP")
            shadow_result = self._executor.execute(
                self._model_registry.get(shadow_plan.selected_model),
                request.messages,
            ).model_dump(mode="json")

        return {
            "request_id": request.request_id,
            "live_policy": f"{live_policy.name}:{live_policy.version}",
            "live_selected_model": live_plan.selected_model,
            "shadow_policy": f"{shadow_policy.name}:{shadow_policy.version}",
            "shadow_selected_model": shadow_plan.selected_model,
            "live_output": live_result.content,
            "shadow_executed": execute_shadow,
            "shadow_output": shadow_result,
        }
