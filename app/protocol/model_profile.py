from typing import Any

from pydantic import BaseModel, Field


class ModelProfile(BaseModel):
    id: str = Field(min_length=1)
    executor: str = Field(min_length=1)
    executor_model: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    status: str = Field(min_length=1)
    supports: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, Any] = Field(default_factory=dict)
    cost: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
