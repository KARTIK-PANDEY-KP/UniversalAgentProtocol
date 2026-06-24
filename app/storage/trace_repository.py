from typing import Protocol

from app.storage.schemas import TraceRecord
from app.storage.supabase_client import SupabaseClient


class TraceRepository(Protocol):
    def insert_trace(self, trace: TraceRecord) -> None:
        """Persist a runtime trace."""

    def list_traces(self) -> list[TraceRecord]:
        """Return traces visible to this repository."""


class MemoryTraceRepository:
    def __init__(self) -> None:
        self._traces: list[TraceRecord] = []

    def insert_trace(self, trace: TraceRecord) -> None:
        self._traces.append(trace)

    def list_traces(self) -> list[TraceRecord]:
        return list(self._traces)


class SupabaseTraceRepository:
    def __init__(self, client: SupabaseClient) -> None:
        self._client = client

    def insert_trace(self, trace: TraceRecord) -> None:
        self._client.upsert("traces", trace.model_dump(mode="json"), on_conflict="request_id")

    def list_traces(self) -> list[TraceRecord]:
        rows = self._client.select("traces")
        return [TraceRecord.model_validate(row) for row in rows]
