from pathlib import Path

from app.registries.errors import UnknownPublicModelError
from app.registries.schemas import PublicModelAlias, TenantConfig
from app.registries.yaml_loader import load_yaml_mapping

DEFAULT_TENANT_CONFIG_PATH = Path(__file__).with_name("tenant_config.yaml")


class TenantRegistry:
    def __init__(self, public_aliases: list[PublicModelAlias], tenants: list[TenantConfig]) -> None:
        self._public_aliases = {alias.public_model: alias for alias in public_aliases}
        self._tenants = {tenant.tenant_id: tenant for tenant in tenants}

    @classmethod
    def from_yaml(cls, path: Path = DEFAULT_TENANT_CONFIG_PATH) -> "TenantRegistry":
        data = load_yaml_mapping(path)
        aliases = [
            PublicModelAlias.model_validate(item) for item in data.get("public_model_aliases", [])
        ]
        tenants = [TenantConfig.model_validate(item) for item in data.get("tenants", [])]
        return cls(public_aliases=aliases, tenants=tenants)

    def list_public_models(self) -> list[str]:
        return list(self._public_aliases.keys())

    def resolve_public_model(self, public_model: str) -> PublicModelAlias:
        try:
            return self._public_aliases[public_model]
        except KeyError as exc:
            raise UnknownPublicModelError(f"Unknown public model: {public_model}") from exc

    def tenant_config(self, tenant_id: str | None) -> TenantConfig:
        if tenant_id and tenant_id in self._tenants:
            return self._tenants[tenant_id]
        return self._tenants.get("default", TenantConfig())
