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
        tool_choice: str | dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        if plan.mode == "multi_call":
            return self._execute_multi_call(plan, messages, tools, tool_choice, response_format)
        if plan.mode == "context_routing":
            messages = self._context_messages(plan, messages)
        model_ids = self._execution_model_ids(plan)
        last_error: ProviderExecutionError | None = None
        executable_model_ids = [model_id for model_id in model_ids if model_id is not None]
        for index, model_id in enumerate(executable_model_ids):
            try:
                max_tokens = self._max_tokens_for(plan, model_id)
                result = self._executor.execute(
                    self._model_lookup(model_id),
                    messages,
                    tools=tools,
                    tool_choice=tool_choice,
                    response_format=response_format,
                    max_tokens=max_tokens,
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

    @staticmethod
    def _max_tokens_for(plan: RoutePlan, model_id: str) -> int | None:
        for step in plan.steps:
            if step.model == model_id and step.max_tokens is not None:
                return step.max_tokens
        generation = plan.metadata.get("generation", {})
        if isinstance(generation, dict) and isinstance(generation.get("max_tokens"), int):
            return int(generation["max_tokens"])
        return None

    @staticmethod
    def _context_messages(
        plan: RoutePlan,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        context_plan = plan.metadata.get("context_plan", {})
        if not isinstance(context_plan, dict):
            return messages
        snippets = context_plan.get("context_snippets", [])
        if not isinstance(snippets, list) or not snippets:
            return messages
        context_text = "\n\n".join(str(snippet) for snippet in snippets)
        return [
            {
                "role": "system",
                "content": f"Use this selected Brainbase context when helpful:\n{context_text}",
            },
            *messages,
        ]

    def _execute_multi_call(
        self,
        plan: RoutePlan,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
        response_format: dict[str, Any] | None,
    ) -> ExecutionResult:
        step_results: list[dict[str, Any]] = []
        total_input_tokens = 0
        total_output_tokens = 0
        total_cost = 0.0
        total_latency = 0
        for step in plan.steps:
            step_messages = self._messages_for_step(messages, step_results, step.role)
            result = self._executor.execute(
                self._model_lookup(step.model),
                step_messages,
                tools=tools,
                tool_choice=tool_choice,
                response_format=response_format,
                max_tokens=step.max_tokens or self._max_tokens_for(plan, step.model),
            )
            step_results.append(
                {
                    "role": step.role,
                    "model": step.model,
                    "content": result.content,
                    "finish_reason": result.finish_reason,
                }
            )
            total_input_tokens += result.input_tokens
            total_output_tokens += result.output_tokens
            total_cost += result.cost_usd
            total_latency += result.latency_ms
        final_content = self._aggregate_multi_call(step_results)
        return ExecutionResult(
            content=final_content,
            model=plan.steps[-1].model,
            finish_reason="stop",
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            cost_usd=total_cost,
            latency_ms=total_latency,
            raw_response={"multi_call_steps": step_results},
        )

    @staticmethod
    def _messages_for_step(
        base_messages: list[dict[str, Any]],
        previous_results: list[dict[str, Any]],
        role: str | None,
    ) -> list[dict[str, Any]]:
        if not previous_results:
            return base_messages
        prior = "\n\n".join(
            f"{result.get('role') or 'step'}: {result.get('content') or ''}"
            for result in previous_results
        )
        instruction = {
            "role": "system",
            "content": (
                f"You are the {role or 'next'} stage in a Brainbase multi-call route. "
                f"Use prior stage outputs when useful:\n{prior}"
            ),
        }
        return [instruction, *base_messages]

    @staticmethod
    def _aggregate_multi_call(step_results: list[dict[str, Any]]) -> str:
        judge_or_final = [
            result
            for result in step_results
            if result.get("role") in {"judge", "judge_merge", "final", "merge"}
        ]
        selected = judge_or_final[-1] if judge_or_final else step_results[-1]
        content = selected.get("content")
        return str(content or "")
