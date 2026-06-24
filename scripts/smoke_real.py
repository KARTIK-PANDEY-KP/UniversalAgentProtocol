import os


def main() -> None:
    if os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() != "true":
        raise SystemExit("Refusing real provider smoke without RUN_REAL_PROVIDER_TESTS=true")
    raise SystemExit("Real provider smoke is implemented after the executor wave.")


if __name__ == "__main__":
    main()
