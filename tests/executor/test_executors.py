from typing import Any

import httpx
import pytest

from app.executor import FallbackExecutor, MockExecutor, PortkeyExecutor
from app.executor.errors import InvalidModelStringError, ProviderExecutionError
from app.executor.execution_result import ExecutionResult
from app.executor.openrouter_model_resolver import resolve_openrouter_executor_model
from app.executor.types import ChatExecutor
from app.protocol import ModelProfile, RoutePlan


def profile(model_id: str = "openrouter:openai/gpt-4o-mini") -> ModelProfile:
    return ModelProfile(
        id=model_id,
        executor="portkey",
        executor_model=resolve_openrouter_executor_model(model_id),
        provider="openrouter",
        status="enabled",
        supports={"tools": True, "vision": True, "json": True},
        limits={"context_window": 128000},
        cost={"input_per_million": 0.15, "output_per_million": 0.60},
        capabilities={"overall": 0.7},
    )


def test_mock_executor_returns_valid_execution_result() -> None:
    result = MockExecutor().execute(
        profile(),
        [{"role": "user", "content": "Say hello"}],
    )

    assert result.content is not None
    assert result.content.startswith("Brainbase mock response")
    assert result.input_tokens > 0
    assert result.output_tokens > 0
    assert result.cost_usd == 0


def test_openrouter_model_string_resolver() -> None:
    assert (
        resolve_openrouter_executor_model("openrouter:anthropic/claude-3-haiku")
        == "@openrouter/anthropic/claude-3-haiku"
    )


def test_invalid_model_string_errors() -> None:
    with pytest.raises(InvalidModelStringError):
        resolve_openrouter_executor_model("anthropic:claude-3-haiku")


def test_portkey_executor_posts_selected_model() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = request.headers
        captured["json"] = request.read().decode()
        return httpx.Response(
            200,
            headers={"x-portkey-cost-usd": "0.001"},
            json={
                "model": "@openrouter/openai/gpt-4o-mini",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "hello"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = PortkeyExecutor(api_key="test-key", http_client=client).execute(
        profile(),
        [{"role": "user", "content": "hello"}],
    )

    assert captured["headers"]["x-portkey-api-key"] == "test-key"
    assert "@openrouter/openai/gpt-4o-mini" in captured["json"]
    assert result.content == "hello"
    assert result.cost_usd == 0.001


def test_portkey_executor_provider_error() -> None:
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(500)))

    with pytest.raises(ProviderExecutionError):
        PortkeyExecutor(api_key="test-key", http_client=client).execute(
            profile(),
            [{"role": "user", "content": "hello"}],
        )


class FailingOnceExecutor(ChatExecutor):
    def __init__(self) -> None:
        self.calls = 0

    def execute(
        self,
        model: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        del messages, tools, response_format
        self.calls += 1
        if self.calls == 1:
            raise ProviderExecutionError("primary failed")
        return ExecutionResult(content="fallback", model=model.executor_model)


def test_fallback_executor_uses_fallback_after_provider_error() -> None:
    models = {
        "openrouter:primary/model": profile("openrouter:primary/model"),
        "openrouter:fallback/model": profile("openrouter:fallback/model"),
    }
    plan = RoutePlan(
        mode="single",
        selected_model="openrouter:primary/model",
        fallback_models=["openrouter:fallback/model"],
        policy_name="manual-rules",
        policy_version="v0",
    )

    result = FallbackExecutor(FailingOnceExecutor(), models.__getitem__).execute(
        plan,
        [{"role": "user", "content": "hello"}],
    )

    assert result.content == "fallback"
    assert result.fallback_used is True
