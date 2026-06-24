import argparse
import os

from app.executor.openrouter_model_resolver import resolve_openrouter_executor_model


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate an internal OpenRouter model id.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    executor_model = resolve_openrouter_executor_model(args.model)
    if args.execute and os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() != "true":
        raise SystemExit("Refusing model execution without RUN_REAL_PROVIDER_TESTS=true")
    print(executor_model)


if __name__ == "__main__":
    main()
