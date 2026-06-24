from pathlib import Path
from typing import Any

from app.config import Settings
from app.evals.benchmark_runner import BenchmarkRunner


class ReplayRunner:
    def __init__(self, benchmark_runner: BenchmarkRunner | None = None) -> None:
        self._benchmark_runner = benchmark_runner or BenchmarkRunner()

    def replay(self, dataset_path: Path, policy: str) -> dict[str, Any]:
        return self._benchmark_runner.run(
            dataset_paths=[dataset_path],
            policies=[policy],
            settings=Settings(executor_mode="mock"),
            dry_run=True,
        )
