import pytest

from app.executor.errors import InvalidModelStringError
from app.executor.openrouter_model_resolver import resolve_openrouter_executor_model
from app.registries import ModelRegistry, PolicyRegistry, TenantRegistry
from app.registries.errors import UnknownModelError, UnknownPolicyError, UnknownPublicModelError


def test_yaml_model_registry_loads_models() -> None:
    registry = ModelRegistry.from_yaml()

    assert registry.get("openrouter:openai/gpt-4o-mini").executor == "portkey"
    assert registry.get("openrouter:openai/gpt-4o-mini").status == "enabled"


def test_candidate_filtering_by_pool_excludes_disabled_models() -> None:
    registry = ModelRegistry.from_yaml()
    candidates = registry.candidates_for_pool("premium")

    assert "openrouter:anthropic/claude-3-5-sonnet" in [model.id for model in candidates]
    assert "openrouter:openai/gpt-4o" not in [model.id for model in candidates]


def test_unknown_model_returns_clear_error() -> None:
    registry = ModelRegistry.from_yaml()

    with pytest.raises(UnknownModelError, match="Unknown model id"):
        registry.get("openrouter:nope/missing")


def test_yaml_policy_registry_loads_policies() -> None:
    registry = PolicyRegistry.from_yaml()

    policy = registry.get("always-strongest", "v0")
    assert policy.status == "enabled"


def test_unknown_policy_returns_clear_error() -> None:
    registry = PolicyRegistry.from_yaml()

    with pytest.raises(UnknownPolicyError, match="Unknown policy"):
        registry.get("hydra", "v9")


def test_tenant_registry_loads_public_aliases() -> None:
    registry = TenantRegistry.from_yaml()

    assert registry.list_public_models() == [
        "brainbase-chat",
        "brainbase-code",
        "brainbase-agent",
        "brainbase-fast",
        "brainbase-premium",
    ]
    alias = registry.resolve_public_model("brainbase-code")
    assert alias.model_pool == "coding"
    assert alias.mode == "code"


def test_unknown_public_model_returns_clear_error() -> None:
    registry = TenantRegistry.from_yaml()

    with pytest.raises(UnknownPublicModelError, match="Unknown public model"):
        registry.resolve_public_model("brainbase-router-v1")


def test_dynamic_openrouter_model_string_parsing() -> None:
    assert (
        resolve_openrouter_executor_model("openrouter:qwen/new-model")
        == "@openrouter/qwen/new-model"
    )


def test_invalid_dynamic_model_string_errors() -> None:
    with pytest.raises(InvalidModelStringError):
        resolve_openrouter_executor_model("openai:gpt-latest")
