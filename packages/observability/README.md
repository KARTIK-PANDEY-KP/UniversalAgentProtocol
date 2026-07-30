# observability

## Responsibility

Structured logging, counters and histograms, and the redaction pass that keeps
credentials out of both. Every module below the apps takes a logger and a
metrics sink rather than reaching for a global, so a test can assert on what
was recorded.

## Does not own

- Where logs and metrics go. This module produces records; the deployable in
  `apps/` decides the sink.
- Audit events. Those are a product feature with a table behind them and belong
  to `@uap/federation`, not to telemetry.
- Deciding what is a secret. `redact.ts` knows the shapes of the credentials
  this system handles; a module that invents a new one extends the redactor.

## Public interface

`@uap/observability`, from `src/index.ts`.

- `logger.ts` — `Logger`, the JSON-line implementation, and child loggers that
  carry a bound context.
- `metrics.ts` — the counter and histogram sink.
- `metric-names.ts` — the metric names, in one place, so a dashboard and the
  code that emits cannot drift apart.
- `redact.ts` — redaction applied to every value before it is logged.

## Depends on

- `@uap/core` — for `Clock` and the JSON types.

## Data ownership

No tables.

## Entry points

`src/index.ts`.

## Invariants

- Redaction is applied by the logger, not by callers. A caller that has to
  remember to redact will eventually forget.
- Bearer tokens, refresh tokens, client secrets, authorization codes, DPoP
  proofs and `Authorization` headers never appear in output, at any log level.
- Metric names come from `metric-names.ts`. A literal at a call site is a name
  no dashboard knows about.

## Testing

```bash
pnpm --filter @uap/observability test
```

## Owners

`@platform`
