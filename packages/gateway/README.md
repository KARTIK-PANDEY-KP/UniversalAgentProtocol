# gateway — the composition layer

## Responsibility

Assembling the modules into a running system: reading configuration, opening
the store, constructing each service with its dependencies, mounting the HTTP
routes, and defining the periodic work the background worker performs.

This is where the wiring lives, and it is the only place that knows about every
module. Nothing depends on it except the deployables in `apps/`.

## Does not own

- Any business rule. If a decision is being made here, it belongs in the module
  that owns the capability.
- Process lifecycle. Signals, exit codes and shutdown ordering belong to the
  deployables in `apps/`.
- Protocol handling, credentials or persistence, each of which has a module.

## Public interface

`@uap/gateway`, from `src/index.ts`.

- `config.ts` — the configuration schema, its defaults, and validation. One
  place to learn every knob the operator has.
- `gateway.ts` — `createGateway()`, which constructs the object graph and hands
  back something an app can start.
- `router.ts` — the HTTP router and the middleware chain, including downstream
  authentication and per-tenant rate limiting.
- `routes.ts` — the control-plane API and the OAuth callback.
- `background-worker.ts` — the periodic jobs: token refresh, catalogue resync,
  session reaping, rate-limiter sweeping.

## Depends on

- `@uap/core`
- `@uap/observability`
- `@uap/security`
- `@uap/storage`
- `@uap/oauth`
- `@uap/mcp-server`
- `@uap/federation`

## Data ownership

No tables of its own. It opens the store and hands repositories to the modules
that own them.

## Entry points

`src/index.ts`, then `createGateway(config)`.

## Invariants

- Configuration is validated once, at startup. A misconfigured gateway refuses
  to start rather than failing on the first request that needs the setting.
- Every route resolves a principal before doing anything, and passes that
  principal down. No route reads a tenant id from the request body.
- `routes.ts` is the one file the standard warns about — the central registry
  every feature wants to edit. Keep it to routing: parse, authorize, delegate,
  serialise. Logic in a handler here is logic in the wrong module.
- The background worker's jobs are idempotent and independently scheduled. One
  failing job does not stop the others.

## Testing

```bash
pnpm --filter @uap/conformance-tests test
```

## Owners

`@platform`
