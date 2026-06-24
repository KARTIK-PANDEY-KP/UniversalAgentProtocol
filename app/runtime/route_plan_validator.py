from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.registries.schemas import PublicModelAlias
from app.runtime.errors import RoutePlanValidationError

EXECUTABLE_MODES = {
    "single",
    "cascade",
    "agent_step",
    "multi_call",
    "budgeted_single",
    "context_routing",
}


class RoutePlanValidator:
    def validate(
        self,
        plan: RoutePlan,
        request: RouterRequest,
        candidates: list[ModelProfile],
        alias: PublicModelAlias,
        budget: RoutingBudget,
    ) -> None:
        if plan.mode not in EXECUTABLE_MODES:
            raise RoutePlanValidationError(f"RoutePlan mode is not executable in MVP: {plan.mode}")
        if plan.policy_name != alias.policy_name or plan.policy_version != alias.policy_version:
            raise RoutePlanValidationError("RoutePlan policy does not match public model alias")
        if plan.mode == "cascade" and len(plan.steps) > budget.max_cascade_depth:
            raise RoutePlanValidationError("RoutePlan exceeds max cascade depth")
        if plan.mode == "multi_call" and not budget.allow_multi_call:
            raise RoutePlanValidationError("RoutePlan multi_call requires allow_multi_call=true")

        candidate_by_id = {candidate.id: candidate for candidate in candidates}
        model_ids = self._model_ids(plan)
        for model_id in model_ids:
            model = candidate_by_id.get(model_id)
            if model is None:
                raise RoutePlanValidationError(
                    f"RoutePlan selected model outside candidate pool: {model_id}"
                )
            if model.status != "enabled":
                raise RoutePlanValidationError(f"RoutePlan selected disabled model: {model_id}")
            self._validate_support(model, request)

        if budget.max_cost_usd is not None:
            estimated_cost = sum(
                self._estimated_cost(candidate_by_id[model_id]) for model_id in model_ids
            )
            if estimated_cost > budget.max_cost_usd:
                raise RoutePlanValidationError("RoutePlan exceeds max cost budget")

    @staticmethod
    def _model_ids(plan: RoutePlan) -> list[str]:
        ids: list[str] = []
        if plan.selected_model is not None:
            ids.append(plan.selected_model)
        ids.extend(step.model for step in plan.steps)
        ids.extend(plan.fallback_models)
        return ids

    @staticmethod
    def _validate_support(model: ModelProfile, request: RouterRequest) -> None:
        if request.tools and not bool(model.supports.get("tools", False)):
            raise RoutePlanValidationError(f"Model does not support tools: {model.id}")
        if request.response_format and not bool(model.supports.get("json", False)):
            response_type = request.response_format.get("type")
            if response_type in {"json_object", "json_schema"}:
                raise RoutePlanValidationError(
                    f"Model does not support JSON response format: {model.id}"
                )

    @staticmethod
    def _estimated_cost(model: ModelProfile) -> float:
        input_cost = model.cost.get("input_per_million", 0)
        output_cost = model.cost.get("output_per_million", 0)
        if not isinstance(input_cost, int | float) or not isinstance(output_cost, int | float):
            return 0.0
        return float(input_cost + output_cost) / 1_000_000
