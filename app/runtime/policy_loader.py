from app.policies import (
    AlwaysCheapestPolicy,
    AlwaysFastestPolicy,
    AlwaysStrongestPolicy,
    ManualRulesPolicy,
    RandomPolicy,
)
from app.policies.base import RouterPolicy
from app.registries.policy_registry import PolicyRegistry


class PolicyLoader:
    def __init__(self, policy_registry: PolicyRegistry) -> None:
        self._policy_registry = policy_registry

    def load(self, name: str, version: str) -> RouterPolicy:
        registration = self._policy_registry.get(name, version)
        if registration.name == "always-strongest":
            return AlwaysStrongestPolicy()
        if registration.name == "always-cheapest":
            return AlwaysCheapestPolicy()
        if registration.name == "always-fastest":
            return AlwaysFastestPolicy()
        if registration.name == "manual-rules":
            return ManualRulesPolicy()
        if registration.name == "random":
            seed = int(registration.config.get("seed", 0))
            return RandomPolicy(seed=seed)
        raise ValueError(
            f"Policy is registered but has no local implementation: {registration.key}"
        )
