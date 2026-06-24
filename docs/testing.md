# Testing

Normal tests are free and do not call paid providers.

```bash
make install
make lint
make typecheck
make test
make smoke-mock
make check
```

Modes:

- Mock local: `EXECUTOR_MODE=mock REGISTRY_MODE=yaml STORAGE_MODE=memory`
- Supabase integration: `EXECUTOR_MODE=mock REGISTRY_MODE=supabase STORAGE_MODE=supabase`
- Real provider smoke: `EXECUTOR_MODE=portkey REGISTRY_MODE=supabase STORAGE_MODE=supabase`

Real Supabase tests require:

```bash
RUN_SUPABASE_TESTS=true make test tests/storage
```

Real Portkey/OpenRouter tests require:

```bash
RUN_REAL_PROVIDER_TESTS=true make smoke-real
```

Do not put real provider calls in normal pytest suites.
