from app.registries.schemas import PublicModelAlias
from app.registries.tenant_registry import TenantRegistry


class PublicModelResolver:
    def __init__(self, tenant_registry: TenantRegistry) -> None:
        self._tenant_registry = tenant_registry

    def list_public_models(self) -> list[str]:
        return self._tenant_registry.list_public_models()

    def resolve(self, public_model: str) -> PublicModelAlias:
        return self._tenant_registry.resolve_public_model(public_model)
