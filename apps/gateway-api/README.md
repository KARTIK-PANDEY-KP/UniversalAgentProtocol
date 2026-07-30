# gateway-api

## Responsibility

The deployable that serves traffic. It reads configuration from the
environment, builds a gateway, binds an HTTP listener, and shuts down cleanly
on a signal.

It is deliberately thin. Everything it does beyond process management is a call
into `@uap/gateway`.

## Does not own

- Anything. If it grows a decision, that decision belongs in a module.

## Public interface

None. This is a deployable, not a library, and no module may depend on it.

## Depends on

- `@uap/gateway`

## Data ownership

No tables. It opens the store that `@uap/storage` owns.

## Entry points

`src/main.ts`.

```bash
pnpm --filter @uap/gateway-api start
```

## Invariants

- Binds `0.0.0.0` on `$PORT`, so it works unchanged behind a platform load
  balancer.
- Configuration is read once at startup and never re-read from the environment
  afterwards.
- A shutdown signal stops accepting connections, drains in-flight requests, and
  closes the store.

## Testing

```bash
pnpm --filter @uap/conformance-tests test
```

The conformance harness starts this deployable the way an operator would.

## Owners

`@platform`
