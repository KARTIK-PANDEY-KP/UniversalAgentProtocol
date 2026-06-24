.PHONY: install lint typecheck test smoke-mock smoke-real benchmark-mock benchmark-dry-run benchmark-canary-real check

UV := $(shell command -v uv 2>/dev/null || command -v $(HOME)/.local/bin/uv 2>/dev/null || echo uv)

install:
	$(UV) sync --dev

lint:
	$(UV) run ruff check .

typecheck:
	$(UV) run mypy

test:
	$(UV) run pytest $(filter-out test check,$(MAKECMDGOALS))

smoke-mock:
	PYTHONPATH=. EXECUTOR_MODE=mock REGISTRY_MODE=yaml STORAGE_MODE=memory $(UV) run python scripts/smoke_mock.py

smoke-real:
	PYTHONPATH=. RUN_REAL_PROVIDER_TESTS=$${RUN_REAL_PROVIDER_TESTS:-false} $(UV) run python scripts/smoke_real.py

benchmark-mock:
	PYTHONPATH=. EXECUTOR_MODE=mock REGISTRY_MODE=yaml STORAGE_MODE=memory $(UV) run python scripts/benchmark_policy.py --dataset sample_datasets/basic_prompts.jsonl --policies always-strongest,always-cheapest --executor mock

benchmark-dry-run:
	PYTHONPATH=. EXECUTOR_MODE=mock REGISTRY_MODE=yaml STORAGE_MODE=memory $(UV) run python scripts/benchmark_policy.py --dataset sample_datasets/basic_prompts.jsonl --policies always-strongest,always-cheapest --dry-run

benchmark-canary-real:
	PYTHONPATH=. RUN_REAL_PROVIDER_TESTS=$${RUN_REAL_PROVIDER_TESTS:-false} $(UV) run python scripts/benchmark_policy.py --datasets sample_datasets/basic_prompts.jsonl --policies always-cheapest,always-fastest --limit-per-dataset 1 --max-real-calls 2 --max-cost-usd 0.50 --timeout-seconds 30 --executor portkey

check: lint typecheck test smoke-mock benchmark-mock benchmark-dry-run

%:
	@:
