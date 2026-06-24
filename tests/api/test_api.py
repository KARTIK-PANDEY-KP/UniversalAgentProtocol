from typing import Any

from fastapi.testclient import TestClient

from app.dependencies import runtime_kernel_dependency
from app.main import app


class FakeKernel:
    def __init__(self) -> None:
        self.payload: dict[str, Any] | None = None

    def list_public_models(self) -> list[str]:
        return ["brainbase-chat"]

    def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payload = payload
        return {
            "id": "chatcmpl_test",
            "object": "chat.completion",
            "created": 1,
            "model": payload["model"],
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }


def test_health() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_models_delegates_to_runtime() -> None:
    fake = FakeKernel()
    app.dependency_overrides[runtime_kernel_dependency] = lambda: fake
    try:
        response = TestClient(app).get("/v1/models")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["data"][0]["id"] == "brainbase-chat"


def test_chat_completions_delegates_to_runtime() -> None:
    fake = FakeKernel()
    app.dependency_overrides[runtime_kernel_dependency] = lambda: fake
    try:
        response = TestClient(app).post(
            "/v1/chat/completions",
            json={
                "model": "brainbase-chat",
                "messages": [{"role": "user", "content": "hello"}],
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "brainbase-chat"
    assert fake.payload is not None
    assert fake.payload["messages"][0]["content"] == "hello"


def test_chat_completions_bad_request_handling() -> None:
    response = TestClient(app).post(
        "/v1/chat/completions",
        json={"model": "brainbase-chat", "messages": []},
    )

    assert response.status_code == 422


def test_chat_completions_works_in_mock_mode() -> None:
    response = TestClient(app).post(
        "/v1/chat/completions",
        json={
            "model": "brainbase-chat",
            "messages": [{"role": "user", "content": "Say hello."}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "brainbase-chat"
    assert body["choices"][0]["message"]["role"] == "assistant"
