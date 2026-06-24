from typing import Any


def compare_policy_costs(results: list[dict[str, Any]]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for result in results:
        policy = result.get("policy")
        if isinstance(policy, str):
            totals[policy] = totals.get(policy, 0.0) + float(result.get("estimated_cost_usd", 0.0))
    return totals
