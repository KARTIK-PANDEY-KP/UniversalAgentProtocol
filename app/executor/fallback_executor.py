from collections.abc import Callable
from typing import Any

from app.executor.errors import ProviderExecutionError
from app.executor.execution_result import ExecutionResult
from app.executor.types import ChatExecutor
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan

ModelLookup = Callable[[str], ModelProfile]


class FallbackExecutor:
    def __init__(self, executor: ChatExecutor, model_lookup: ModelLookup) -> None:
        self._executor = executor
        self._model_lookup = model_lookup

    def execute(
        self,
        plan: RoutePlan,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        model_ids = self._execution_model_ids(plan)
        last_error: ProviderExecutionError | None = None
        executable_model_ids = [model_id for model_id in model_ids if model_id is not None]
        for index, model_id in enumerate(executable_model_ids):
            try:
                result = self._executor.execute(
                    self._model_lookup(model_id),
                    messages,
                    tools=tools,
                    response_format=response_format,
                )
                result.fallback_used = index > 0
                return result
            except ProviderExecutionError as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise ProviderExecutionError("RoutePlan did not include an executable selected model")

    @staticmethod
    def _execution_model_ids(plan: RoutePlan) -> list[str | None] | list[str]:
        if plan.mode == "cascade":
            return [step.model for step in plan.steps] + plan.fallback_models
        return [plan.selected_model, *plan.fallback_models]
