"""RouterPolicy plug-ins."""

from app.policies.always_cheapest import AlwaysCheapestPolicy
from app.policies.always_fastest import AlwaysFastestPolicy
from app.policies.always_strongest import AlwaysStrongestPolicy
from app.policies.manual_rules import ManualRulesPolicy
from app.policies.random_policy import RandomPolicy

__all__ = [
    "AlwaysCheapestPolicy",
    "AlwaysFastestPolicy",
    "AlwaysStrongestPolicy",
    "ManualRulesPolicy",
    "RandomPolicy",
]
