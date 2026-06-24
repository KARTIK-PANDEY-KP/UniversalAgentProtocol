from collections.abc import Callable

from app.policies.errors import PolicyError
from app.protocol.model_profile import ModelProfile


def enabled_candidates(candidates: list[ModelProfile]) -> list[ModelProfile]:
    return [candidate for candidate in candidates if candidate.status == "enabled"]


def require_candidates(candidates: list[ModelProfile]) -> list[ModelProfile]:
    available = enabled_candidates(candidates)
    if not available:
        raise PolicyError("No enabled model candidates are available")
    return available


def numeric_metric(profile: ModelProfile, path: tuple[str, ...], default: float) -> float:
    value: object = profile
    for part in path:
        if isinstance(value, ModelProfile):
            value = getattr(value, part)
        elif isinstance(value, dict):
            value = value.get(part)
        else:
            return default
    if isinstance(value, int | float):
        return float(value)
    return default


def choose_best(
    candidates: list[ModelProfile],
    key: Callable[[ModelProfile], float],
    reverse: bool = True,
) -> ModelProfile:
    available = require_candidates(candidates)
    return sorted(available, key=key, reverse=reverse)[0]
