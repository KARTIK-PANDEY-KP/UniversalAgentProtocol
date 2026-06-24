from typing import Any

from pydantic import BaseModel, Field


class ExecutionResult(BaseModel):
    content: str | None
    model: str
    finish_reason: str = "stop"
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = Field(default=0.0, ge=0.0)
    latency_ms: int = Field(default=0, ge=0)
    raw_response: dict[str, Any] = Field(default_factory=dict)
    fallback_used: bool = False
