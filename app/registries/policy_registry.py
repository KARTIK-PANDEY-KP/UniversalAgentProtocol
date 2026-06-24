from pathlib import Path

from app.registries.errors import UnknownPolicyError
from app.registries.schemas import PolicyRegistration
from app.registries.yaml_loader import load_yaml_mapping
from app.storage.supabase_client import SupabaseClient

DEFAULT_POLICY_REGISTRY_PATH = Path(__file__).with_name("policy_registry.yaml")


class PolicyRegistry:
    def __init__(self, policies: list[PolicyRegistration]) -> None:
        self._policies = {policy.key: policy for policy in policies}

    @classmethod
    def from_yaml(cls, path: Path = DEFAULT_POLICY_REGISTRY_PATH) -> "PolicyRegistry":
        data = load_yaml_mapping(path)
        policies = [PolicyRegistration.model_validate(item) for item in data.get("policies", [])]
        return cls(policies=policies)

    @classmethod
    def from_supabase(cls, client: SupabaseClient) -> "PolicyRegistry":
        policies = [
            PolicyRegistration.model_validate(row) for row in client.select("policy_registry")
        ]
        return cls(policies=policies)

    def list_policies(self) -> list[PolicyRegistration]:
        return list(self._policies.values())

    def get(self, name: str, version: str) -> PolicyRegistration:
        key = f"{name}:{version}"
        try:
            return self._policies[key]
        except KeyError as exc:
            raise UnknownPolicyError(f"Unknown policy: {key}") from exc
