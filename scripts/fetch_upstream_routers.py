import argparse
import shutil
import subprocess
from pathlib import Path

from app.policies.upstream_catalog import UPSTREAM_ROUTER_SOURCES


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch official upstream router repositories.")
    parser.add_argument("--output-dir", default="vendor/upstream")
    parser.add_argument("--source", choices=sorted(UPSTREAM_ROUTER_SOURCES.keys()))
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    source_names = list(UPSTREAM_ROUTER_SOURCES) if args.all else [args.source]
    if not source_names or source_names == [None]:
        raise SystemExit("Provide --source or --all")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in source_names:
        if name is None:
            continue
        source = UPSTREAM_ROUTER_SOURCES[name]
        if source.repository is None:
            print(f"{name}: skipped ({source.status})")
            continue
        destination = output_dir / name
        if destination.exists():
            shutil.rmtree(destination)
        subprocess.run(
            ["git", "clone", "--depth", "1", source.repository, str(destination)],
            check=True,
        )
        if source.commit:
            subprocess.run(
                ["git", "fetch", "--depth", "1", "origin", source.commit],
                cwd=destination,
                check=True,
            )
            subprocess.run(["git", "checkout", source.commit], cwd=destination, check=True)
        print(f"{name}: fetched {source.repository} at {source.commit or 'default HEAD'}")


if __name__ == "__main__":
    main()
