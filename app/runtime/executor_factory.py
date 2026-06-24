from app.config import Settings
from app.executor.mock_executor import MockExecutor
from app.executor.portkey_executor import PortkeyExecutor
from app.executor.types import ChatExecutor


def build_executor(settings: Settings) -> ChatExecutor:
    if settings.executor_mode == "mock":
        return MockExecutor()
    if settings.executor_mode == "portkey":
        if not settings.portkey_api_key:
            raise ValueError("PORTKEY_API_KEY is required when EXECUTOR_MODE=portkey")
        return PortkeyExecutor(settings.portkey_api_key)
    raise ValueError(f"Unknown EXECUTOR_MODE: {settings.executor_mode}")
