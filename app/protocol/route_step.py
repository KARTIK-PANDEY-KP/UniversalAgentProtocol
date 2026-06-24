from typing import Any

from pydantic import BaseModel, Field


class RouteStep(BaseModel):
    model: str = Field(min_length=1)
    role: str | None = None
    condition: str | None = None
    max_tokens: int | None = Field(default=None, ge=1)
    timeout_ms: int | None = Field(default=None, ge=1)
    verifier: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
