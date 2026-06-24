from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.protocol.route_step import RouteStep

RoutePlanMode = Literal[
    "single",
    "cascade",
    "agent_step",
    "multi_call",
    "budgeted_single",
    "context_routing",
]


class RoutePlan(BaseModel):
    mode: RoutePlanMode
    selected_model: str | None = None
    steps: list[RouteStep] = Field(default_factory=list)
    fallback_models: list[str] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    policy_name: str = Field(min_length=1)
    policy_version: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_plan_shape(self) -> "RoutePlan":
        if self.mode in {"single", "agent_step", "budgeted_single", "context_routing"} and (
            not self.selected_model
        ):
            raise ValueError(f"selected_model is required for mode={self.mode}")
        if self.mode in {"cascade", "multi_call"} and not self.steps:
            raise ValueError(f"steps are required for mode={self.mode}")
        return self
