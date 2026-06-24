from fastapi.testclient import TestClient

from app.main import app


def main() -> None:
    client = TestClient(app)
    health = client.get("/health")
    health.raise_for_status()
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "brainbase-chat",
            "messages": [{"role": "user", "content": "Say hello in one sentence."}],
        },
    )
    response.raise_for_status()
    body = response.json()
    assert body["model"] == "brainbase-chat"
    print("smoke-mock passed")


if __name__ == "__main__":
    main()
