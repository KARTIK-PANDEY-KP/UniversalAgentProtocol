# Add a new policy

1. Create a policy package under `app/policies/<policy_name>/`.
2. Implement `RouterPolicy.plan(...) -> RoutePlan`.
3. Do not call providers, Portkey, Supabase, or HTTP from policy code.
4. Register the policy in `app/registries/policy_registry.yaml`.
5. Add focused policy tests under `tests/policies/`.
6. Run:

```bash
make test tests/policies
make benchmark-dry-run
```

To expose a policy through a public Brainbase model, update
`app/registries/tenant_config.yaml`. Public names must not include the word `router`.
