# Migration

You already have remote MCP servers configured in Cursor, Claude Code and
Codex, each with its own OAuth grant. Migration moves those servers behind the
gateway so every application shares one grant per server.

The one thing that cannot be automated is the authorization itself. An existing
refresh token is the grant between you, *that application*, the authorization
server and the resource. It is not transferable, and copying it would be
exactly the client impersonation the gateway refuses to do. So the shape of the
migration is:

**Import the URLs automatically, reauthorize each protected server once, and
store the new credentials centrally.**

After that, every additional MCP client is a URL and a key. No further
authorization.

## The CLI

```bash
export GATEWAY_URL=https://gateway.example.com
export GATEWAY_API_KEY=...

umg-migrate discover     # what you have today
umg-migrate import       # create one gateway connection per server
umg-migrate status       # who still needs authorizing
umg-migrate install      # point your applications at the gateway
umg-migrate prune --yes  # optional: remove the direct entries
umg-migrate rollback     # undo the last install or prune
```

During development, run it as `node apps/migration-cli/dist/main.js`.

Useful flags: `--dry-run` on `install` and `prune`, `--client cursor` to limit
the scope, `--json` for machine-readable output, `--allow-http` for local
gateways, and `--cwd <path>` to scan a project other than the current
directory.

## What gets read

| Client | Files |
| --- | --- |
| Cursor | `~/.cursor/mcp.json`, `<project>/.cursor/mcp.json` |
| Claude Code | `~/.claude.json` including its per-project maps, `<project>/.mcp.json` |
| Claude Desktop | `claude_desktop_config.json` in the platform location |
| Codex | `~/.codex/config.toml`, `<project>/.codex/config.toml` |
| VS Code | `<project>/.vscode/mcp.json` |

Comments in JSON files are tolerated. A file that cannot be parsed is reported
and skipped; it never stops the other clients from migrating.

## discover

Lists every configuration file found, the remote servers in each, and the
servers to import after deduplication. URLs are canonicalized the same way the
gateway canonicalizes them, so `https://mcp.example.com/mcp` configured in
Cursor and `https://mcp.example.com/mcp/` configured in Codex are recognised as
one server and become one connection.

Local stdio servers are listed as skipped. A hosted gateway cannot launch a
program on your machine, so they stay configured directly and keep working.

The gateway's own entry is never imported into itself, which is what makes
`discover` and `import` safe to re-run after `install`.

## import

Sends the deduplicated list to `POST /api/v1/import`. Each URL becomes one
upstream connection, named after whatever you already called it. Importing a
URL that already has a connection returns the existing one, so the command is
idempotent: re-running it after a partial migration does not create duplicates
and does not ask for a second authorization.

Servers that need OAuth come back as `AUTHORIZATION_REQUIRED` with a link:

```
Authorize each protected server once, in a browser:
  github: https://gateway.example.com/connect/conn_01H...
  slack:  https://gateway.example.com/connect/conn_01H...
```

Open each one, approve, done. Servers that need no authorization are connected
immediately and their tools are already available.

`umg-migrate status` shows where things stand, and `--fail-on-pending` makes it
exit non-zero while anything is still unauthorized, which is convenient in a
script.

## install

Adds the gateway to each client's configuration as a normal remote MCP server:

```json
{
  "mcpServers": {
    "universal-gateway": {
      "type": "http",
      "url": "https://gateway.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:UMG_GATEWAY_API_KEY}" }
    }
  }
}
```

The key is written as a reference to an environment variable, not as a value,
using each client's own syntax. Set it in your shell profile before starting
the application:

```bash
export UMG_GATEWAY_API_KEY=...
```

Use `--api-key-env` to change the variable name.

Claude Desktop cannot dereference an environment variable, so it is skipped
with an explanation. Pass `--inline-key` to write the key into the file
literally, understanding that it then sits in plain text on disk.

A client that has left no trace on the machine is skipped too, rather than
having a configuration file invented for it. Naming it with `--client codex`
overrides that, which is what you want when installing ahead of the
application.

Codex is edited in place rather than reserialized: comments, formatting and
existing tables are preserved byte for byte. The CLI adds
`experimental_use_rmcp_client = true` above every table, which is where Codex
requires it, and writes `bearer_token_env_var` with the *name* of the variable.

Running `install` twice changes nothing the second time.

## prune

Removes the direct entries the gateway has taken over. This is the only
destructive command, so it asks first and needs `--yes`.

It only removes a server that the gateway is actually serving — a connection in
`CONNECTED`, `CONNECTED_NON_REFRESHABLE` or `DEGRADED`. A server you imported
but never authorized keeps its direct entry and keeps working exactly as
before. Local stdio servers and the gateway's own entry are never touched.

`--dry-run` shows what would go.

## rollback

Every `install` and `prune` copies each file it is about to change into
`~/.universal-mcp-gateway/backups/<id>/` and writes a manifest. `rollback`
restores the most recent one — including deleting a file the CLI created,
rather than leaving an empty one behind — and then discards it, so repeated
rollbacks walk back through the history. `umg-migrate backups` lists what is
available and `--backup-id` picks a specific one.

Rolling back client configuration does not touch the gateway. The connections
and their grants remain, so reinstalling later needs no browser.

## Verifying

Restart the applications and confirm the gateway's tools are listed. Names are
`alias.tool_name`, for example `github.search_code`, so it is obvious which
upstream a tool came from.

`conformance/tests/migration.test.ts` runs this whole journey against a real
gateway and two mock upstreams, asserting that each server is authorized
exactly once, that the configuration the CLI writes actually connects, that
pruning removes only what is served, and that rollback restores every file
byte for byte.

## After migration

Connecting a new upstream is `POST /api/v1/connections` plus one browser round
trip, and it appears in every client at once. Adding a new client is a URL and
a key, with no upstream authorization at all.

If you would rather not run `prune`, nothing breaks: the direct entries keep
their own grants and the gateway keeps its own. The only cost is that the same
tools appear twice.
