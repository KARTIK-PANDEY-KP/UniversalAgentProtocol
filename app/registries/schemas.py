from typing import Any

from pydantic import BaseModel, Field


class PublicModelAlias(BaseModel):
    public_model: str = Field(min_length=1)
    policy_name: str = Field(min_length=1)
    policy_version: str = Field(min_length=1)
    model_pool: str = Field(min_length=1)
    mode: str = Field(min_length=1)
    config: dict[str, Any] = Field(default_factory=dict)


class PolicyRegistration(BaseModel):
    name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    type: str = Field(min_length=1)
    status: str = Field(min_length=1)
    supported_modes: list[str] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)
    artifact_uri: str | None = None

    @property
    def key(self) -> str:
        return f"{self.name}:{self.version}"


class TenantConfig(BaseModel):
    tenant_id: str = "default"
    allowed_public_models: list[str] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)
