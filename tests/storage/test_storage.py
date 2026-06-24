from pathlib import Path
from typing import Any

import pytest

from app.config import Settings
from app.storage import (
    BenchmarkRunRecord,
    MemoryBenchmarkRepository,
    MemoryTraceRepository,
    SupabaseClient,
    SupabaseTraceRepository,
    TraceRecord,
)
from app.storage.benchmark_repository import SupabaseBenchmarkRepository
from app.storage.registry_repository import SupabaseRegistryRepository


class FakeSupabaseClient:
    def __init__(self) -> None:
        self.inserts: list[tuple[str, dict[str, Any]]] = []
        self.upserts: list[tuple[str, dict[str, Any], str | None]] = []
        self.rows: dict[str, list[dict[str, Any]]] = {}

    def insert(self, table: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.inserts.append((table, payload))
        return payload

    def upsert(
        self,
        table: str,
        payload: dict[str, Any],
        on_conflict: str | None = None,
    ) -> dict[str, Any]:
        self.upserts.append((table, payload, on_conflict))
        return payload

    def select(self, table: str, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
        del params
        return self.rows.get(table, [])


def trace_record() -> TraceRecord:
    return TraceRecord(
        request_id="req_123",
        public_model="brainbase-chat",
        policy_name="manual-rules",
        policy_version="v0",
        route_plan={"mode": "single"},
        selected_model="openrouter:openai/gpt-4o-mini",
    )


def test_supabase_client_initializes_from_env_settings() -> None:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="secret",
    )

    client = SupabaseClient.from_settings(settings)
    client.close()


def test_supabase_client_requires_url_and_service_key() -> None:
    with pytest.raises(ValueError):
        SupabaseClient.from_settings(Settings())


def test_memory_trace_repository_inserts_trace() -> None:
    repository = MemoryTraceRepository()
    repository.insert_trace(trace_record())

    assert repository.list_traces()[0].request_id == "req_123"


def test_trace_insert_with_mocked_supabase_client() -> None:
    fake = FakeSupabaseClient()
    repository = SupabaseTraceRepository(fake)  # type: ignore[arg-type]

    repository.insert_trace(trace_record())

    assert fake.upserts[0][0] == "traces"
    assert fake.upserts[0][2] == "request_id"


def test_model_registry_read_write_with_mocked_client() -> None:
    fake = FakeSupabaseClient()
    fake.rows["model_registry"] = [{"id": "openrouter:openai/gpt-4o-mini"}]
    repository = SupabaseRegistryRepository(fake)  # type: ignore[arg-type]

    repository.upsert_model({"id": "openrouter:openai/gpt-4o-mini"})

    assert repository.list_models()[0]["id"] == "openrouter:openai/gpt-4o-mini"


def test_policy_registry_read_write_with_mocked_client() -> None:
    fake = FakeSupabaseClient()
    fake.rows["policy_registry"] = [{"name": "manual-rules", "version": "v0"}]
    repository = SupabaseRegistryRepository(fake)  # type: ignore[arg-type]

    repository.insert_policy({"name": "manual-rules", "version": "v0"})

    assert repository.list_policies()[0]["name"] == "manual-rules"


def test_benchmark_insert_with_mocked_repository() -> None:
    run = BenchmarkRunRecord(
        name="mock",
        policy_name="manual-rules",
        policy_version="v0",
        dataset_name="basic",
        mode="mock",
    )
    memory = MemoryBenchmarkRepository()
    memory.insert_run(run)
    assert memory.list_runs()[0].name == "mock"

    fake = FakeSupabaseClient()
    SupabaseBenchmarkRepository(fake).insert_run(run)  # type: ignore[arg-type]
    assert fake.inserts[0][0] == "benchmark_runs"


def test_schema_file_exists() -> None:
    schema = Path("database/supabase_schema.sql")

    assert schema.exists()
    assert "create table if not exists public.traces" in schema.read_text()
