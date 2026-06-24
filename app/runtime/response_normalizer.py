import time
import uuid
from typing import Any

from app.executor.execution_result import ExecutionResult
from app.protocol.route_plan import RoutePlan
from app.protocol.router_request import RouterRequest


class ResponseNormalizer:
    def normalize(
        self,
        request: RouterRequest,
        result: ExecutionResult,
        plan: RoutePlan,
    ) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "assistant", "content": result.content}
        if result.tool_calls:
            message["tool_calls"] = result.tool_calls
        response: dict[str, Any] = {
            "id": f"chatcmpl_{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.public_model,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": result.finish_reason,
                }
            ],
            "usage": {
                "prompt_tokens": result.input_tokens,
                "completion_tokens": result.output_tokens,
                "total_tokens": result.input_tokens + result.output_tokens,
            },
        }
        routing_options = request.metadata.get("routing", {})
        if isinstance(routing_options, dict) and routing_options.get("debug") is True:
            response["brainbase_routing"] = {
                "policy_name": plan.policy_name,
                "policy_version": plan.policy_version,
                "route_plan_mode": plan.mode,
                "selected_model": plan.selected_model,
                "fallback_used": result.fallback_used,
                "confidence": plan.confidence,
                "latency_ms": result.latency_ms,
                "cost_usd": result.cost_usd,
            }
        return response
