# Brainbase Model Runtime

Backend-only MVP shell for first-party Brainbase model names:

- `brainbase-chat`
- `brainbase-code`
- `brainbase-agent`
- `brainbase-fast`
- `brainbase-premium`

The public API is OpenAI-compatible. Internally, the runtime is built around a stable
`RouterPolicy.plan(...) -> RoutePlan` protocol, Portkey/OpenRouter execution, and Supabase
traces/registries.

## Local setup

```bash
make install
make check
```

Normal development uses mock/YAML/memory mode and never calls paid providers.

## Runtime flow

1. Receive `POST /v1/chat/completions`.
2. Normalize to `RouterRequest`.
3. Resolve the public Brainbase model alias.
4. Load candidate `ModelProfile`s.
5. Load a `RouterPolicy`.
6. Call `RouterPolicy.plan(...) -> RoutePlan`.
7. Validate the plan.
8. Execute through mock mode or Portkey/OpenRouter.
9. Normalize the OpenAI-compatible response.
10. Store a trace.

## Important commands

```bash
make lint
make typecheck
make test
make smoke-mock
make benchmark-mock
make benchmark-dry-run
```

Real provider calls are never run by normal tests:

```bash
RUN_REAL_PROVIDER_TESTS=true make smoke-real
RUN_REAL_PROVIDER_TESTS=true make benchmark-canary-real
```

Full benchmarks require explicit `--full --confirm-cost` flags and should not be run during MVP
development.

## Documentation

- [Customer usage](docs/customer-usage.md)
- [Internal RouterPolicy contract](docs/internal-router-policy.md)
- [Add a new model](docs/add-new-model.md)
- [Add a new policy](docs/add-new-policy.md)
- [Testing](docs/testing.md)
- [Benchmarking](docs/benchmarking.md)
- [Deployment](docs/deployment.md)
