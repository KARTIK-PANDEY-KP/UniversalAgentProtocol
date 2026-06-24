from app.protocol.model_profile import ModelProfile
from app.registries.model_registry import ModelRegistry


class ModelCandidateResolver:
    def __init__(self, model_registry: ModelRegistry) -> None:
        self._model_registry = model_registry

    def candidates_for_pool(self, model_pool: str) -> list[ModelProfile]:
        return self._model_registry.candidates_for_pool(model_pool)
