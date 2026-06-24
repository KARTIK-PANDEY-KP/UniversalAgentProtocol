from typing import Any

from pydantic import BaseModel, Field


class FeedbackEvent(BaseModel):
    request_id: str = Field(min_length=1)
    tenant_id: str | None = None
    public_model: str | None = None
    selected_model: str | None = None
    policy_name: str | None = None
    policy_version: str | None = None
    user_feedback: str | None = None
    tool_success: bool | None = None
    workflow_success: bool | None = None
    quality_score: float | None = Field(default=None, ge=0.0, le=1.0)
    latency_ms: int | None = Field(default=None, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)
