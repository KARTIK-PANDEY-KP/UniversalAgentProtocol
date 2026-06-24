from typing import Any, Protocol

from app.executor.execution_result import ExecutionResult
from app.protocol.model_profile import ModelProfile


class ChatExecutor(Protocol):
    def execute(
        self,
        model: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
        max_tokens: int | None = None,
    ) -> ExecutionResult:
        """Execute a validated model profile."""
