import os
import time

import pytest

from app.config import Settings
from app.registries import ModelRegistry, PolicyRegistry, TenantRegistry
from app.runtime.kernel import RuntimeKernel
from app.storage import SupabaseClient, SupabaseObjectRepository


def real_supabase_settings() -> Settings:
    return Settings(
        supabase_url=os.getenv("SUPABASE_URL"),
        supabase_secret_key=os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
        supabase_service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
        portkey_api_key=os.getenv("PORTKEY_API_KEY"),
    )


def require_supabase() -> Settings:
    if os.getenv("RUN_SUPABASE_TESTS", "false").lower() != "true":
        pytest.skip("RUN_SUPABASE_TESTS=true is required")
    settings = real_supabase_settings()
    if not settings.supabase_url or not (
        settings.supabase_secret_key or settings.supabase_service_role_key
    ):
        pytest.skip("Supabase URL and service key are required")
    return settings


def require_real_provider(settings: Settings) -> None:
    if os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() != "true":
        pytest.skip("RUN_REAL_PROVIDER_TESTS=true is required")
    if not settings.portkey_api_key:
        pytest.skip("PORTKEY_API_KEY is required")


def test_real_supabase_registries_and_storage() -> None:
    settings = require_supabase()
    client = SupabaseClient.from_settings(settings)

    model_registry = ModelRegistry.from_supabase(client)
    policy_registry = PolicyRegistry.from_supabase(client)
    tenant_registry = TenantRegistry.from_supabase(client)

    assert model_registry.candidates_for_pool("default")
    assert policy_registry.get("manual-rules", "v0").status == "enabled"
    assert "brainbase-chat" in tenant_registry.list_public_models()

    repository = SupabaseObjectRepository(client)
    repository.ensure_bucket()
    object_path = f"integration/real-supabase-{int(time.time())}.txt"
    repository.put_text(object_path, "brainbase real storage check")
    assert repository.get_text(object_path) == "brainbase real storage check"


def test_real_provider_runtime_with_supabase_registry_and_trace() -> None:
    settings = require_supabase()
    require_real_provider(settings)
    runtime_settings = settings.model_copy(
        update={
            "executor_mode": "portkey",
            "registry_mode": "supabase",
            "storage_mode": "supabase",
        }
    )
    response = RuntimeKernel.from_settings(runtime_settings).chat_completion(
        {
            "model": "brainbase-fast",
            "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
            "routing": {"max_cost_usd": 0.01},
        }
    )

    assert response["model"] == "brainbase-fast"
    assert response["choices"][0]["finish_reason"] == "stop"
