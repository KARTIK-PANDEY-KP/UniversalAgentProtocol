import argparse
import json
import os
from pathlib import Path

from app.config import Settings
from app.evals.benchmark_runner import BenchmarkRunner

ALL_DATASETS = [
    Path("sample_datasets/basic_prompts.jsonl"),
    Path("sample_datasets/code_prompts.jsonl"),
    Path("sample_datasets/reasoning_prompts.jsonl"),
    Path("sample_datasets/agent_tool_prompts.jsonl"),
    Path("sample_datasets/support_prompts.jsonl"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Brainbase benchmark runner.")
    parser.add_argument("--dataset")
    parser.add_argument("--datasets")
    parser.add_argument("--policies", required=True)
    parser.add_argument("--executor", default="mock")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--confirm-cost", action="store_true")
    parser.add_argument("--limit-per-dataset", type=int)
    parser.add_argument("--max-real-calls", type=int)
    parser.add_argument("--max-cost-usd", type=float)
    parser.add_argument("--timeout-seconds", type=int)
    args = parser.parse_args()

    if args.full and not args.confirm_cost:
        raise SystemExit("Full benchmark requires --full --confirm-cost")
    if args.datasets == "all" and (not args.full or not args.confirm_cost):
        raise SystemExit("Full benchmark over all datasets requires --full --confirm-cost")
    if args.executor == "portkey" and (
        args.limit_per_dataset is None
        or args.max_real_calls is None
        or args.max_cost_usd is None
        or args.timeout_seconds is None
    ):
        raise SystemExit("Real benchmark requires call, cost, dataset, and timeout caps")
    real_tests_enabled = os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() == "true"
    if args.executor == "portkey" and not real_tests_enabled:
        raise SystemExit("Refusing real benchmark without RUN_REAL_PROVIDER_TESTS=true")

    dataset_paths = _dataset_paths(args.dataset, args.datasets)
    settings = Settings(executor_mode=args.executor)
    report = BenchmarkRunner().run(
        dataset_paths=dataset_paths,
        policies=args.policies.split(","),
        settings=settings,
        dry_run=args.dry_run,
        limit_per_dataset=args.limit_per_dataset,
        max_real_calls=args.max_real_calls,
        max_cost_usd=args.max_cost_usd,
    )
    print(json.dumps(report["metrics"], sort_keys=True))


def _dataset_paths(dataset: str | None, datasets: str | None) -> list[Path]:
    if dataset:
        return [Path(dataset)]
    if datasets == "all":
        return ALL_DATASETS
    if datasets:
        return [Path(item) for item in datasets.split(",")]
    raise SystemExit("Provide --dataset or --datasets")


if __name__ == "__main__":
    main()
