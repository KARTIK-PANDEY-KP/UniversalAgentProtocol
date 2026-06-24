import argparse
import json
from pathlib import Path
from typing import Any


def load_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Brainbase benchmark placeholder.")
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
    if args.executor == "portkey" and (
        args.limit_per_dataset is None
        or args.max_real_calls is None
        or args.max_cost_usd is None
        or args.timeout_seconds is None
    ):
        raise SystemExit("Real benchmark requires call, cost, dataset, and timeout caps")

    dataset = Path(args.dataset or (args.datasets or "").split(",")[0])
    rows = load_rows(dataset)
    print(
        json.dumps(
            {
                "mode": "dry-run" if args.dry_run else "mock",
                "rows": len(rows),
                "policies": args.policies.split(","),
                "executor": args.executor,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
