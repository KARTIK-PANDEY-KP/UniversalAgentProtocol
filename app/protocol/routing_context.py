from typing import Any

from pydantic import BaseModel, Field


class RoutingContext(BaseModel):
    tenant_config: dict[str, Any] = Field(default_factory=dict)
    public_model_config: dict[str, Any] = Field(default_factory=dict)
    workflow_context: dict[str, Any] | None = None
    historical_performance: dict[str, Any] | None = None
    policy_config: dict[str, Any] = Field(default_factory=dict)
