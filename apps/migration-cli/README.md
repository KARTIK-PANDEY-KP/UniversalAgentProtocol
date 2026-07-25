# migration-cli

## Responsibility

Moving an existing setup onto the gateway. It finds the MCP servers already
configured in local clients, imports them as gateway connections, rewrites each
client's configuration to point at the gateway instead, and can put everything
back.

This is the only module that reads or writes files belonging to another
application, which is why backup and rollback are part of its contract rather
than an afterthought.

## Does not own

- Connection semantics. It calls the gateway's control-plane API over HTTP like
  any other client and has no privileged access.
- Any client's configuration format beyond reading and writing it. Knowledge of
  each format is confined to `clients.ts`.

## Public interface

`@uap/migration-cli`, from `src/index.ts`. The exports exist so the conformance
suite can drive the commands in-process; the supported interface for humans is
the command line.

- `discovery.ts` — finding configured MCP servers on this machine.
- `clients.ts` — where each supported client keeps its configuration and how it
  is shaped.
- `plan.ts` — the change set, computed before anything is written.
- `backup.ts` — snapshots taken before a write, and restoring from them.
- `config-file.ts` — atomic read/modify/write that preserves formatting.
- `gateway-client.ts` — the control-plane API client.
- `commands.ts` — `discover`, `import`, `status`, `install`, `prune`,
  `rollback`, `backups`.

## Depends on

- `@uap/observability`

Deliberately not `@uap/storage` or `@uap/gateway`: the CLI is a remote client
of a running gateway, not a second way into its database.

## Data ownership

No tables. It owns the backup files it writes, under its own directory.

## Entry points

`src/main.ts`.

```bash
pnpm --filter @uap/migration-cli start -- discover
pnpm --filter @uap/migration-cli start -- import --dry-run
```

## Invariants

- Every command that writes supports `--dry-run`, and the plan it prints is the
  plan it would execute.
- Nothing is written without a backup being taken first, and `rollback`
  restores from that backup.
- Writes are atomic: a temporary file replaced by rename, so an interrupted run
  cannot leave a client with a truncated configuration.
- Comments and formatting in a client's configuration survive a rewrite.
- The CLI never reads the gateway's database, even when running on the same
  host.

## Testing

```bash
pnpm --filter @uap/migration-cli test
```

Tests run against temporary directories holding realistic client
configurations.

## Owners

`@platform`
