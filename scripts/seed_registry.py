from app.registries import ModelRegistry, PolicyRegistry, TenantRegistry


def main() -> None:
    models = ModelRegistry.from_yaml().list_models()
    policies = PolicyRegistry.from_yaml().list_policies()
    public_models = TenantRegistry.from_yaml().list_public_models()
    print(
        {
            "models": len(models),
            "policies": len(policies),
            "public_models": public_models,
        }
    )


if __name__ == "__main__":
    main()
