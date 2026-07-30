# database-cli

## Responsibility

The deployable that prepares a database for the gateway and reports on one,
without starting a gateway to do it.

The gateway creates its own schema on boot, so this is not required to run one.
It exists for the cases where booting is the wrong moment to find out: a deploy
pipeline that wants the schema in place before the first instance starts, a
credential that needs checking before it is trusted, and the question "is my
data actually in there" — which, on a gateway whose whole job is to remember
OAuth grants, is worth being able to ask directly.

## Does not own

- The schema. `@uap/storage` defines it; this app runs it and counts what came
  out.
- Choosing a backend. It resolves the same environment variables the gateway
  resolves, deliberately, so that a database prepared here is the one the
  gateway will open.
- Data migration between backends. It creates tables; it does not move rows.

## Public interface

`runProvision` and `runCheck`, exported so the conformance tests can call them
without spawning a process. No module may depend on this app.

## Depends on

- `@uap/storage`

## Data ownership

No tables of its own. It creates the ones `@uap/storage` defines.

## Entry points

`src/main.ts`.

```bash
uap-db provision --url postgres://user:pass@host:5432/db --schema uap
uap-db check                       # reads GATEWAY_DATABASE_URL
uap-db check --file ~/.uap/gateway.sqlite
uap-db check --json
```

## Invariants

- `provision` is idempotent. Every statement in the schema is
  `IF NOT EXISTS`, so a pipeline may rerun it on every deploy.
- `check` writes nothing.
- An unreachable database is reported as unreachable. The row counts have to
  swallow their errors, because a missing table is what they are looking for,
  so reachability is established first on a statement no schema can affect.
  Otherwise a refused connection reads as an empty database and sends the
  operator to fix the wrong thing.
- `:memory:` is refused rather than prepared, since the result would not
  outlive the command.
- Passwords are never printed.
- Exit code is 0 when the schema is complete and 1 when it is not, so
  `uap-db check` can gate a deploy.

## Testing

```bash
pnpm --filter @uap/database-cli test
TEST_POSTGRES_URL=postgres://... pnpm --filter @uap/database-cli test
```

The suite runs against SQLite always and against Postgres when a server is
offered, because a command whose purpose is portability is not demonstrated by
one backend.

## Owners

`@platform`
