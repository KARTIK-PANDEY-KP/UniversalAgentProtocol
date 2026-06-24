from typing import Any

from app.storage.supabase_client import SupabaseClient


class SupabaseRegistryRepository:
    def __init__(self, client: SupabaseClient) -> None:
        self._client = client

    def upsert_model(self, model: dict[str, Any]) -> dict[str, Any]:
        return self._client.upsert("model_registry", model, on_conflict="id")

    def list_models(self) -> list[dict[str, Any]]:
        return self._client.select("model_registry")

    def insert_policy(self, policy: dict[str, Any]) -> dict[str, Any]:
        return self._client.insert("policy_registry", policy)

    def list_policies(self) -> list[dict[str, Any]]:
        return self._client.select("policy_registry")
