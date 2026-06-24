import argparse
import json
from pathlib import Path

import httpx

from app.evals.benchmark_catalog import get_benchmark, list_benchmarks


def main() -> None:
    parser = argparse.ArgumentParser(description="Download or materialize benchmark metadata.")
    parser.add_argument("--benchmark", choices=[item.name for item in list_benchmarks()])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--output-dir", default="sample_datasets/downloaded")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--confirm-download", action="store_true")
    args = parser.parse_args()

    if args.full and not args.confirm_download:
        raise SystemExit("Full benchmark download requires --full --confirm-download")
    names = [item.name for item in list_benchmarks()] if args.all else [args.benchmark]
    if not names or names == [None]:
        raise SystemExit("Provide --benchmark or --all")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        if name is None:
            continue
        resource = get_benchmark(name)
        target_dir = output_dir / resource.name
        target_dir.mkdir(parents=True, exist_ok=True)
        manifest = resource.model_dump(mode="json")
        if args.full:
            manifest["download_note"] = _fetch_resource_note(resource.url)
        else:
            manifest["download_note"] = (
                "metadata_only; use --full --confirm-download for network fetch"
            )
        (target_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"benchmark": resource.name, "path": str(target_dir / "manifest.json")}))


def _fetch_resource_note(url: str) -> str:
    response = httpx.get(url, timeout=20, follow_redirects=True)
    response.raise_for_status()
    return response.text[:2000]


if __name__ == "__main__":
    main()
