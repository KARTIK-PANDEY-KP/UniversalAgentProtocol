import uuid
from typing import Any

from app.protocol.router_request import RouterRequest


def normalize_chat_request(payload: dict[str, Any]) -> RouterRequest:
    metadata = dict(payload.get("metadata") or {})
    routing = payload.get("routing") or payload.get("extra_body", {}).get("routing")
    routing = dict(routing) if isinstance(routing, dict) else {}
    top_level_max_tokens = payload.get("max_tokens") or payload.get("max_completion_tokens")
    if "max_tokens" not in routing and isinstance(top_level_max_tokens, int):
        routing["max_tokens"] = top_level_max_tokens
    if isinstance(routing, dict):
        metadata["routing"] = routing
    return RouterRequest(
        request_id=str(payload.get("request_id") or f"req_{uuid.uuid4().hex}"),
        public_model=str(payload["model"]),
        messages=payload["messages"],
        tools=payload.get("tools"),
        tool_choice=payload.get("tool_choice"),
        response_format=payload.get("response_format"),
        modality=str(payload.get("modality", "text")),
        tenant_id=payload.get("tenant_id"),
        workflow_id=payload.get("workflow_id"),
        step_id=payload.get("step_id"),
        metadata=metadata,
    )
