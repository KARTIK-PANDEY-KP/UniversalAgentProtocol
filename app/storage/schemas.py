from typing import Any

from pydantic import BaseModel, Field


class TraceRecord(BaseModel):
    request_id: str = Field(min_length=1)
    public_model: str = Field(min_length=1)
    tenant_id: str | None = None
    policy_name: str = Field(min_length=1)
    policy_version: str = Field(min_length=1)
    route_plan: dict[str, Any]
    selected_model: str | None = None
    candidate_models: list[str] = Field(default_factory=list)
    fallback_used: bool = False
    request_messages: list[dict[str, Any]] = Field(default_factory=list)
    request_tools: list[dict[str, Any]] | None = None
    response_format: dict[str, Any] | None = None
    routing_budget: dict[str, Any] = Field(default_factory=dict)
    routing_context: dict[str, Any] = Field(default_factory=dict)
    policy_metadata: dict[str, Any] = Field(default_factory=dict)
    response_content: str | None = None
    response_tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    execution_metadata: dict[str, Any] = Field(default_factory=dict)
    feedback_signals: dict[str, Any] = Field(default_factory=dict)
    training_labels: dict[str, Any] = Field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    status: str = "ok"
    error: str | None = None
    shadow_plan: dict[str, Any] | None = None
    shadow_policy: str | None = None
    shadow_selected_model: str | None = None


class BenchmarkRunRecord(BaseModel):
    name: str = Field(min_length=1)
    policy_name: str = Field(min_length=1)
    policy_version: str = Field(min_length=1)
    dataset_name: str = Field(min_length=1)
    mode: str = Field(min_length=1)
    metrics: dict[str, Any] = Field(default_factory=dict)
    report: dict[str, Any] = Field(default_factory=dict)


class RouterArtifactRecord(BaseModel):
    policy_name: str = Field(min_length=1)
    policy_version: str = Field(min_length=1)
    artifact_uri: str = Field(min_length=1)
    manifest: dict[str, Any] = Field(default_factory=dict)
    eval_report: dict[str, Any] = Field(default_factory=dict)
    status: str = "registered"
