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

Real Supabase registry/storage/runtime integration tests require:

```bash
RUN_SUPABASE_TESTS=true RUN_REAL_PROVIDER_TESTS=true \
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... PORTKEY_API_KEY=... \
  uv run pytest tests/integration/test_real_supabase_runtime.py -q
```

Real Portkey/OpenRouter tests require:

```bash
RUN_REAL_PROVIDER_TESTS=true make smoke-real
```

All router plug-in real canary:

```bash
RUN_REAL_PROVIDER_TESTS=true PORTKEY_API_KEY=... make benchmark-canary-real-routers
```

Broad real model matrix:

```bash
RUN_REAL_PROVIDER_TESTS=true SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  PORTKEY_API_KEY=... make model-matrix-real
```

Do not put real provider calls in normal pytest suites.
