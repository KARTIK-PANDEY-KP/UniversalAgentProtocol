from typing import Any

from app.executor.execution_result import ExecutionResult
from app.protocol.model_profile import ModelProfile


class MockExecutor:
    def execute(
        self,
        model: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
        max_tokens: int | None = None,
    ) -> ExecutionResult:
        del tools, response_format, max_tokens
        prompt_text = " ".join(str(message.get("content", "")) for message in messages)
        content = f"Brainbase mock response from {model.id}: {prompt_text[:80]}".strip()
        prompt_tokens = max(1, len(prompt_text.split()))
        completion_tokens = max(1, len(content.split()))
        return ExecutionResult(
            content=content,
            model=model.executor_model,
            finish_reason="stop",
            input_tokens=prompt_tokens,
            output_tokens=completion_tokens,
            cost_usd=0.0,
            latency_ms=1,
            raw_response={"mock": True, "selected_model": model.id},
        )
