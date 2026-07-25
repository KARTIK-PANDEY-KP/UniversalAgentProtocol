# storage

## Responsibility

Every table in the system, the migrations that create them, the repository
interfaces other modules use, and the SQLite implementation of those
interfaces. This is the only module permitted to write SQL.

Repositories are declared as interfaces in `store.ts` and implemented in
`sqlite-store.ts`. Callers depend on the interface, which is what makes both
in-memory testing and a future Postgres backend possible without touching a
business rule.

## Does not own

- Business rules. A repository stores what it is handed; it does not decide
  whether the caller was allowed to hand it over.
- Encryption. Credentials arrive already sealed by `@umg/security`'s vault, and
  this module has no way to open them.
- Cross-record consistency beyond a transaction. Reconciling a catalogue with
  an upstream belongs to `@umg/federation`.

## Public interface

`@umg/storage`, from `src/index.ts`.

- `store.ts` — `Store` and every repository interface on it. This is the
  contract other modules are written against.
- `schema.ts` — the tables and the ordered migrations.
- `sqlite-store.ts` — the `node:sqlite` implementation.
- `Table` — the small typed row helper the implementation is built from, shared
  because the migration CLI needs it too.

## Depends on

- `@umg/core`
- `@umg/security` — for the encrypted-column types.

## Data ownership

Every table, and the schema version:

`tenants`, `users`, `tenant_memberships`, `mcp_servers`, `oauth_issuers`,
`oauth_client_registrations`, `upstream_connections`, `oauth_transactions`,
`discovered_tools`, `discovered_resources`, `discovered_prompts`,
`downstream_mcp_sessions`, `upstream_mcp_sessions`, `audit_events`,
`preconfigured_oauth_clients`, `dpop_keys`, `distributed_locks`.

Logical ownership of each table sits with the module whose capability it
serves — connections and catalogues with `@umg/federation`, issuers and
registrations with `@umg/oauth` — but all of them are reached through a
repository declared here. No module issues SQL of its own.

## Entry points

`src/index.ts`, and `openStore()` for a configured database handle.

## Invariants

- Migrations are append-only and numbered. An existing migration is never
  edited, because a deployed database has already run it.
- Every query that reads or writes tenant-scoped data filters on `tenant_id`.
  An id-only lookup is a cross-tenant read waiting for a guessed identifier.
- `Table.upsert` never rewrites `id` or `created_at`. A record keeps its
  identity across conflicts.
- Timestamps are stored as epoch milliseconds.
- Credential columns hold ciphertext. A plaintext value in one of them is a
  bug in the caller, and this module cannot detect it.

## Testing

```bash
pnpm --filter @umg/storage test
```

The tests run against a real SQLite database in a temporary directory.

## Owners

`@platform`
