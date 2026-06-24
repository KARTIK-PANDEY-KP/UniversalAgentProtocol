from app.storage.schemas import BenchmarkRunRecord
from app.storage.supabase_client import SupabaseClient


class MemoryBenchmarkRepository:
    def __init__(self) -> None:
        self._runs: list[BenchmarkRunRecord] = []

    def insert_run(self, run: BenchmarkRunRecord) -> None:
        self._runs.append(run)

    def list_runs(self) -> list[BenchmarkRunRecord]:
        return list(self._runs)


class SupabaseBenchmarkRepository:
    def __init__(self, client: SupabaseClient) -> None:
        self._client = client

    def insert_run(self, run: BenchmarkRunRecord) -> None:
        self._client.insert("benchmark_runs", run.model_dump(mode="json"))
