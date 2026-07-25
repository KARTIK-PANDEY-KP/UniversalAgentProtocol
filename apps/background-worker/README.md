# background-worker

## Responsibility

The deployable that runs the gateway's periodic maintenance against the same
database the API serves from, without listening on a port: refreshing tokens
before they expire, resynchronising upstream catalogues, reaping idle sessions,
and rewrapping credentials after a key rotation.

Like the API, it is thin. The jobs themselves are defined in `@umg/gateway`.

## Does not own

- The jobs. `BackgroundWorker` in `@umg/gateway` owns what each pass does; this
  app owns the schedule's configuration and the process.
- Any HTTP surface. It binds nothing.

## Public interface

None. This is a deployable, and no module may depend on it.

## Depends on

- `@umg/gateway`

## Data ownership

No tables. It writes through the same repositories the API uses.

## Entry points

`src/main.ts`.

```bash
pnpm --filter @umg/background-worker start
pnpm --filter @umg/background-worker start -- --once   # one pass, for cron
```

Intervals come from `WORKER_*` environment variables; see
`docs/operations/running.md`.

## Invariants

- Several replicas may run at once. Every job takes the same connection-scoped
  locks and compare-and-swap paths the request path uses, so a token is
  refreshed once no matter how many workers noticed it was due.
- `--once` performs a single deterministic pass and exits, which is what a
  platform cron scheduler wants.
- A failing job is logged and the pass continues. One unreachable upstream does
  not stop token refresh for everyone else.

## Testing

```bash
pnpm --filter @umg/conformance-tests test
```

## Owners

`@platform`
