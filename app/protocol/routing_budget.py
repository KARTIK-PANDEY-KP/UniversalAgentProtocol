from pydantic import BaseModel, Field


class RoutingBudget(BaseModel):
    max_cost_usd: float | None = Field(default=None, ge=0)
    max_latency_ms: int | None = Field(default=None, ge=1)
    max_cascade_depth: int = Field(default=1, ge=1)
    allow_multi_call: bool = False
    allow_expensive_models: bool = False
    mode: str = "balanced"
