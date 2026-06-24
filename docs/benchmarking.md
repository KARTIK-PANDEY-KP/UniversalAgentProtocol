# Benchmarking

Development-safe benchmark commands:

```bash
make benchmark-mock
make benchmark-dry-run
```

Mock benchmark executes through the mock executor. Dry-run benchmark only produces and validates
`RoutePlan`s.

Canary real benchmarks are opt-in and capped:

```bash
RUN_REAL_PROVIDER_TESTS=true make benchmark-canary-real
```

Canary real mode requires:

- `--limit-per-dataset`
- `--max-real-calls`
- `--max-cost-usd`
- `--timeout-seconds`

Full benchmarks refuse to run without both `--full` and `--confirm-cost`. Do not run full benchmarks
during MVP development.
