from typing import Any


def summarize_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [result for result in results if result.get("error")]
    executed = [result for result in results if result.get("executed")]
    total_cost = sum(float(result.get("estimated_cost_usd", 0.0)) for result in results)
    return {
        "total_cases": len(results),
        "executed_cases": len(executed),
        "error_count": len(errors),
        "estimated_cost_usd": total_cost,
        "selected_model_distribution": _distribution(results, "selected_model"),
        "policy_distribution": _distribution(results, "policy"),
    }


def _distribution(results: list[dict[str, Any]], key: str) -> dict[str, int]:
    distribution: dict[str, int] = {}
    for result in results:
        value = result.get(key)
        if isinstance(value, str):
            distribution[value] = distribution.get(value, 0) + 1
    return distribution
