from pathlib import Path
from typing import Any

from app.config import Settings
from app.evals.benchmark_runner import BenchmarkRunner, load_jsonl_dataset
from app.evals.policy_comparator import compare_policy_costs
from app.evals.report_generator import summarize_results
from app.evals.shadow_runner import ShadowRunner
from app.executor.execution_result import ExecutionResult
from app.executor.mock_executor import MockExecutor
from app.executor.types import ChatExecutor
from app.policies import AlwaysCheapestPolicy, AlwaysStrongestPolicy
from app.protocol import ModelProfile, RouterRequest
from app.registries import ModelRegistry, TenantRegistry
from app.storage import BenchmarkRunRecord, MemoryBenchmarkRepository


def test_dataset_loading() -> None:
    rows = load_jsonl_dataset(Path("sample_datasets/basic_prompts.jsonl"))

    assert rows[0]["public_model"] == "brainbase-chat"


def test_mock_benchmark_execution() -> None:
    report = BenchmarkRunner().run(
        dataset_paths=[Path("sample_datasets/basic_prompts.jsonl")],
        policies=["always-strongest", "always-cheapest"],
        settings=Settings(executor_mode="mock"),
    )

    assert report["metrics"]["executed_cases"] == 2
    assert len(report["results"]) == 2


def test_dry_run_benchmark_execution() -> None:
    report = BenchmarkRunner().run(
        dataset_paths=[Path("sample_datasets/basic_prompts.jsonl")],
        policies=["always-strongest", "always-cheapest"],
        settings=Settings(executor_mode="mock"),
        dry_run=True,
    )

    assert report["metrics"]["executed_cases"] == 0
    assert report["results"][0]["route_plan"]["mode"] == "single"


def test_policy_comparison_and_report_generation() -> None:
    results = [
        {"policy": "a", "selected_model": "m1", "estimated_cost_usd": 0.1, "executed": True},
        {"policy": "a", "selected_model": "m2", "estimated_cost_usd": 0.2, "executed": False},
        {"policy": "b", "selected_model": "m1", "estimated_cost_usd": 0.3, "executed": True},
    ]

    assert summarize_results(results)["total_cases"] == 3
    assert compare_policy_costs(results) == {"a": 0.30000000000000004, "b": 0.3}


def test_benchmark_result_storage_with_mocked_repository() -> None:
    repository = MemoryBenchmarkRepository()
    repository.insert_run(
        BenchmarkRunRecord(
            name="mock",
            policy_name="always-strongest",
            policy_version="v0",
            dataset_name="basic_prompts",
            mode="mock",
        )
    )

    assert repository.list_runs()[0].policy_name == "always-strongest"


class CountingExecutor(ChatExecutor):
    def __init__(self) -> None:
        self.calls = 0

    def execute(
        self,
        model: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        del model, messages, tools, response_format
        self.calls += 1
        return ExecutionResult(content="live", model="mock")


def test_shadow_policy_does_not_execute_model_by_default() -> None:
    model_registry = ModelRegistry.from_yaml()
    tenant_registry = TenantRegistry.from_yaml()
    alias = tenant_registry.resolve_public_model("brainbase-chat")
    executor = CountingExecutor()
    result = ShadowRunner(model_registry, executor).run_shadow(
        request=RouterRequest(
            request_id="req_123",
            public_model="brainbase-chat",
            messages=[{"role": "user", "content": "hello"}],
        ),
        alias=alias.model_copy(update={"policy_name": "always-strongest", "policy_version": "v0"}),
        live_policy=AlwaysStrongestPolicy(),
        shadow_policy=AlwaysCheapestPolicy(),
    )

    assert executor.calls == 1
    assert result["shadow_executed"] is False
    assert result["shadow_selected_model"] is not None


def test_mock_executor_available_for_shadow_execution_if_enabled() -> None:
    model_registry = ModelRegistry.from_yaml()
    tenant_registry = TenantRegistry.from_yaml()
    alias = tenant_registry.resolve_public_model("brainbase-chat")
    result = ShadowRunner(model_registry, MockExecutor()).run_shadow(
        request=RouterRequest(
            request_id="req_123",
            public_model="brainbase-chat",
            messages=[{"role": "user", "content": "hello"}],
        ),
        alias=alias.model_copy(update={"policy_name": "always-strongest", "policy_version": "v0"}),
        live_policy=AlwaysStrongestPolicy(),
        shadow_policy=AlwaysCheapestPolicy(),
        execute_shadow=True,
    )

    assert result["shadow_executed"] is True
    assert result["shadow_output"] is not None
