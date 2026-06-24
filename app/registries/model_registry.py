from pathlib import Path

from app.protocol.model_profile import ModelProfile
from app.registries.errors import UnknownModelError
from app.registries.yaml_loader import load_yaml_mapping
from app.storage.supabase_client import SupabaseClient

DEFAULT_MODEL_REGISTRY_PATH = Path(__file__).with_name("model_registry.yaml")


class ModelRegistry:
    def __init__(self, models: list[ModelProfile], pools: dict[str, list[str]]) -> None:
        self._models = {model.id: model for model in models}
        self._pools = pools

    @classmethod
    def from_yaml(cls, path: Path = DEFAULT_MODEL_REGISTRY_PATH) -> "ModelRegistry":
        data = load_yaml_mapping(path)
        models = [ModelProfile.model_validate(item) for item in data.get("models", [])]
        raw_pools = data.get("model_pools", {})
        pools = {
            str(name): [str(model_id) for model_id in model_ids]
            for name, model_ids in raw_pools.items()
        }
        return cls(models=models, pools=pools)

    @classmethod
    def from_supabase(cls, client: SupabaseClient) -> "ModelRegistry":
        rows = client.select("model_registry")
        models = [ModelProfile.model_validate(row) for row in rows]
        pools: dict[str, list[str]] = {}
        for model in models:
            raw_pools = model.metadata.get("model_pools", [])
            if isinstance(raw_pools, list):
                for pool in raw_pools:
                    pools.setdefault(str(pool), []).append(model.id)
        return cls(models=models, pools=pools)

    def list_models(self) -> list[ModelProfile]:
        return list(self._models.values())

    def add_model(self, model: ModelProfile, model_pools: list[str]) -> None:
        self._models[model.id] = model
        for model_pool in model_pools:
            pool = self._pools.setdefault(model_pool, [])
            if model.id not in pool:
                pool.append(model.id)

    def get(self, model_id: str) -> ModelProfile:
        try:
            return self._models[model_id]
        except KeyError as exc:
            raise UnknownModelError(f"Unknown model id: {model_id}") from exc

    def candidates_for_pool(self, model_pool: str) -> list[ModelProfile]:
        model_ids = self._pools.get(model_pool, [])
        candidates = [self.get(model_id) for model_id in model_ids]
        return [candidate for candidate in candidates if candidate.status == "enabled"]

    def pool_ids(self, model_pool: str) -> list[str]:
        return list(self._pools.get(model_pool, []))
