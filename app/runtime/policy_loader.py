from app.policies import (
    AlwaysCheapestPolicy,
    AlwaysFastestPolicy,
    AlwaysStrongestPolicy,
    AvengersProPolicy,
    BaRPPolicy,
    BoundaryRouterPolicy,
    BrainbaseTrainedPolicy,
    DecoRPolicy,
    GMTRouterPolicy,
    GraphRouterPolicy,
    HydraPolicy,
    LLMRouterPolicy,
    LookaheadPolicy,
    ManualRulesPolicy,
    MFRouterPolicy,
    MTRouterPolicy,
    OrcaRouterPolicy,
    PolicyGuidedStepwisePolicy,
    R2RouterPolicy,
    RandomPolicy,
    RCRRouterPolicy,
    RouteNLPPolicy,
    RouterR1Policy,
    TRouterPolicy,
    TwinRouterBenchPolicy,
)
from app.policies.base import RouterPolicy
from app.registries.policy_registry import PolicyRegistry


class PolicyLoader:
    def __init__(self, policy_registry: PolicyRegistry) -> None:
        self._policy_registry = policy_registry

    def load(self, name: str, version: str) -> RouterPolicy:
        registration = self._policy_registry.get(name, version)
        policy_classes: dict[str, type[RouterPolicy]] = {
            "always-strongest": AlwaysStrongestPolicy,
            "always-cheapest": AlwaysCheapestPolicy,
            "always-fastest": AlwaysFastestPolicy,
            "manual-rules": ManualRulesPolicy,
            "hydra": HydraPolicy,
            "graphrouter": GraphRouterPolicy,
            "llmrouter": LLMRouterPolicy,
            "mf-router": MFRouterPolicy,
            "avengers-pro": AvengersProPolicy,
            "routenlp": RouteNLPPolicy,
            "twinrouterbench": TwinRouterBenchPolicy,
            "mtrouter": MTRouterPolicy,
            "gmtrouter": GMTRouterPolicy,
            "policy-guided-stepwise": PolicyGuidedStepwisePolicy,
            "r2-router": R2RouterPolicy,
            "orcarouter": OrcaRouterPolicy,
            "barp": BaRPPolicy,
            "router-r1": RouterR1Policy,
            "decor": DecoRPolicy,
            "lookahead": LookaheadPolicy,
            "trouter": TRouterPolicy,
            "rcr-router": RCRRouterPolicy,
            "boundary-router": BoundaryRouterPolicy,
            "brainbase-trained": BrainbaseTrainedPolicy,
        }
        if registration.name in policy_classes:
            return policy_classes[registration.name]()
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
