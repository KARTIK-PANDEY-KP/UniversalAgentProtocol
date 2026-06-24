import os

from app.config import Settings
from app.runtime.kernel import RuntimeKernel


def main() -> None:
    if os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() != "true":
        raise SystemExit("Refusing real provider smoke without RUN_REAL_PROVIDER_TESTS=true")
    response = RuntimeKernel.from_settings(Settings(executor_mode="portkey")).chat_completion(
        {
            "model": "brainbase-fast",
            "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
            "routing": {"max_cost_usd": 0.01},
        }
    )
    assert response["model"] == "brainbase-fast"
    print("smoke-real passed")


if __name__ == "__main__":
    main()
