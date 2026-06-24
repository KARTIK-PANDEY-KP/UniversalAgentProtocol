import time
from typing import Any

import httpx

from app.executor.errors import ProviderExecutionError
from app.executor.execution_result import ExecutionResult
from app.protocol.model_profile import ModelProfile

PORTKEY_CHAT_COMPLETIONS_URL = "https://api.portkey.ai/v1/chat/completions"


class PortkeyExecutor:
    def __init__(
        self,
        api_key: str,
        http_client: httpx.Client | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        self._api_key = api_key
        self._http_client = http_client or httpx.Client(timeout=timeout_seconds)
        self._owns_client = http_client is None

    def close(self) -> None:
        if self._owns_client:
            self._http_client.close()

    def execute(
        self,
        model: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        payload: dict[str, Any] = {
            "model": model.executor_model,
            "messages": messages,
        }
        if tools is not None:
            payload["tools"] = tools
        if response_format is not None:
            payload["response_format"] = response_format

        started = time.perf_counter()
        response = self._http_client.post(
            PORTKEY_CHAT_COMPLETIONS_URL,
            headers={
                "Content-Type": "application/json",
                "x-portkey-api-key": self._api_key,
            },
            json=payload,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        if response.status_code >= 400:
            raise ProviderExecutionError(
                f"Portkey execution failed with status {response.status_code}: {response.text}"
            )

        body = response.json()
        choices = body.get("choices", [])
        if not choices:
            raise ProviderExecutionError("Portkey response did not include choices")
        message = choices[0].get("message", {})
        usage = body.get("usage", {})
        return ExecutionResult(
            content=str(message.get("content", "")),
            model=str(body.get("model", model.executor_model)),
            finish_reason=str(choices[0].get("finish_reason", "stop")),
            input_tokens=int(usage.get("prompt_tokens", 0)),
            output_tokens=int(usage.get("completion_tokens", 0)),
            cost_usd=self._parse_cost_header(response),
            latency_ms=latency_ms,
            raw_response=body,
        )

    @staticmethod
    def _parse_cost_header(response: httpx.Response) -> float:
        raw_cost = response.headers.get("x-portkey-cost-usd")
        if raw_cost is None:
            return 0.0
        try:
            return float(raw_cost)
        except ValueError:
            return 0.0
