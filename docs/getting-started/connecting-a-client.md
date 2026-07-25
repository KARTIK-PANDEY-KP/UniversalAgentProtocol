# Connecting a client

The gateway asks nothing unusual of a client: one URL and one bearer
credential. Any MCP client that can reach a remote Streamable HTTP server can
reach this one, unmodified.

- **URL** — `${GATEWAY_BASE_URL}/mcp`
- **Credential** — a gateway API key, or an access token from an authorization
  server you configured in `GATEWAY_AUTHORIZATION_SERVERS`

Everything a client sees is the combined catalogue of every connection
available to it. Tool names are namespaced by connection alias, so two
upstreams offering `search` stay distinct.

## Let the CLI do it

If you already have MCP servers configured locally, the migration CLI will find
them, import them as gateway connections, and rewrite each client's
configuration to point at the gateway instead:

```bash
export GATEWAY_URL=http://127.0.0.1:8787 GATEWAY_API_KEY=dev-key
node apps/migration-cli/dist/main.js discover
node apps/migration-cli/dist/main.js import --dry-run
node apps/migration-cli/dist/main.js import
node apps/migration-cli/dist/main.js install
```

Nothing is written without a backup first, and `rollback` puts everything back.
The full journey, including `prune`, is in
[operations/migration.md](../operations/migration.md).

## Or configure it by hand

```json
{
  "mcpServers": {
    "gateway": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${env:GATEWAY_API_KEY}" }
    }
  }
}
```

That shape works for Cursor, Claude Code and VS Code. Where each client keeps
its configuration file, how it references a secret, and the two clients that
need something different — Claude Desktop cannot dereference an environment
variable, and Codex needs a flag in the right place — are in the table in
[reference/compatibility.md](../reference/compatibility.md).

## Several clients at once

Point as many as you like at the same gateway. Each gets its own MCP session,
its own cursors, its own log level and its own subscriptions. All of them
resolve to the same upstream OAuth grants, so authorizing GitHub once covers
every client you connect afterwards — including ones you install next month.

An upstream that needs reauthorizing is reauthorized once, in a browser, and
every connected client recovers without being reconfigured or restarted.
