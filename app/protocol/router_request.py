from typing import Any

from pydantic import BaseModel, Field


class RouterRequest(BaseModel):
    request_id: str = Field(min_length=1)
    public_model: str = Field(min_length=1)
    messages: list[dict[str, Any]] = Field(min_length=1)
    tools: list[dict[str, Any]] | None = None
    response_format: dict[str, Any] | None = None
    modality: str = "text"
    tenant_id: str | None = None
    workflow_id: str | None = None
    step_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
