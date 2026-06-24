import json
from pathlib import Path
from typing import Any

from app.config import Settings
from app.evals.report_generator import summarize_results
from app.evals.scoring import estimate_model_cost_usd
from app.executor.mock_executor import MockExecutor
from app.executor.types import ChatExecutor
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext
from app.registries.model_registry import ModelRegistry
from app.registries.policy_registry import PolicyRegistry
from app.registries.schemas import PublicModelAlias
from app.registries.tenant_registry import TenantRegistry
from app.runtime.executor_factory import build_executor
from app.runtime.policy_loader import PolicyLoader
from app.runtime.route_plan_validator import RoutePlanValidator


def load_jsonl_dataset(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class BenchmarkRunner:
    def __init__(
        self,
        model_registry: ModelRegistry | None = None,
        policy_registry: PolicyRegistry | None = None,
        tenant_registry: TenantRegistry | None = None,
    ) -> None:
        self._model_registry = model_registry or ModelRegistry.from_yaml()
        self._policy_registry = policy_registry or PolicyRegistry.from_yaml()
        self._tenant_registry = tenant_registry or TenantRegistry.from_yaml()
        self._policy_loader = PolicyLoader(self._policy_registry)
        self._validator = RoutePlanValidator()

    def run(
        self,
        dataset_paths: list[Path],
        policies: list[str],
        settings: Settings,
        dry_run: bool = False,
        limit_per_dataset: int | None = None,
        max_real_calls: int | None = None,
        max_cost_usd: float | None = None,
    ) -> dict[str, Any]:
        executor: ChatExecutor
        if dry_run or settings.executor_mode == "mock":
            executor = MockExecutor()
        else:
            executor = build_executor(settings)
        results: list[dict[str, Any]] = []
        real_calls = 0
        for dataset_path in dataset_paths:
            rows = load_jsonl_dataset(dataset_path)
            if limit_per_dataset is not None:
                rows = rows[:limit_per_dataset]
            for row in rows:
                for policy_name in policies:
                    if settings.executor_mode == "portkey" and not dry_run:
                        real_calls += 1
                        if max_real_calls is not None and real_calls > max_real_calls:
                            raise RuntimeError("Benchmark exceeded max real call cap")
                    result = self._run_case(
                        row=row,
                        dataset_path=dataset_path,
                        policy_name=policy_name,
                        executor=executor,
                        dry_run=dry_run,
                    )
                    results.append(result)
                    if max_cost_usd is not None:
                        total_cost = sum(float(item["estimated_cost_usd"]) for item in results)
                        if total_cost > max_cost_usd:
                            raise RuntimeError("Benchmark exceeded max cost cap")
        return {"metrics": summarize_results(results), "results": results}

    def _run_case(
        self,
        row: dict[str, Any],
        dataset_path: Path,
        policy_name: str,
        executor: Any,
        dry_run: bool,
    ) -> dict[str, Any]:
        alias = self._tenant_registry.resolve_public_model(str(row["public_model"]))
        benchmark_alias = self._alias_for_policy(alias, policy_name)
        candidates = self._model_registry.candidates_for_pool(alias.model_pool)
        request = RouterRequest(
            request_id=str(row["id"]),
            public_model=alias.public_model,
            messages=row["messages"],
            metadata={"benchmark_dataset": str(dataset_path)},
        )
        policy = self._policy_loader.load(policy_name, "v0")
        budget = RoutingBudget(mode=alias.mode)
        context = RoutingContext(public_model_config=benchmark_alias.model_dump(mode="json"))
        plan = policy.plan(request, candidates, context, budget)
        self._validator.validate(plan, request, candidates, benchmark_alias, budget)
        selected_model = plan.selected_model or plan.steps[0].model
        model = self._model_registry.get(selected_model)
        estimated_cost = estimate_model_cost_usd(model)
        content = None
        if not dry_run:
            content = executor.execute(model, request.messages).content
        return {
            "id": row["id"],
            "dataset": str(dataset_path),
            "policy": policy_name,
            "selected_model": selected_model,
            "route_plan": plan.model_dump(mode="json"),
            "estimated_cost_usd": estimated_cost,
            "executed": not dry_run,
            "content": content,
            "error": None,
        }

    @staticmethod
    def _alias_for_policy(alias: PublicModelAlias, policy_name: str) -> PublicModelAlias:
        return alias.model_copy(update={"policy_name": policy_name, "policy_version": "v0"})
