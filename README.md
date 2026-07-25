# Universal MCP OAuth Gateway

Connect each remote MCP server once, through the gateway. Then use that
connection from Cursor, Claude Code, Codex, cloud agents and any other
MCP-compatible application, without repeating the upstream OAuth flow.

The gateway is two things at once. To your applications it is an MCP server
that exposes the combined catalogue of every upstream you have connected. To
those upstreams it is an MCP client and an OAuth client that owns the access
and refresh tokens on your behalf. No downstream application ever receives an
upstream credential, and no application needs to be modified or forked.

There are no provider-specific integrations. GitHub, Slack, Linear and Notion
are reached through the same generic code path as any other standards-compliant
remote MCP server, discovered at runtime from
[protected resource metadata](https://www.rfc-editor.org/rfc/rfc9728.html) and
[authorization server metadata](https://www.rfc-editor.org/rfc/rfc8414.html).

## How it fits together

```
Cursor  ─┐
Claude  ─┼──▶  Gateway /mcp  ──▶  credential vault  ──▶  GitHub MCP
Codex   ─┘     (MCP server)      (one grant each)        Slack MCP
                     │                                   any remote MCP
                     └── separate MCP session per client,
                         shared upstream OAuth grants
```

Each application keeps its own MCP transport session. All of those sessions
resolve to the same upstream authorizations, and only the gateway ever holds or
refreshes the refresh token.

## Quick start

Requires Node 22.5 or newer (the storage layer uses `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm build
pnpm check                      # typecheck plus the full conformance suite
```

Run the gateway locally:

```bash
export GATEWAY_BASE_URL=http://127.0.0.1:8787
export GATEWAY_API_KEYS=dev-key:tenant_local:user_local:laptop
export GATEWAY_ENCRYPTION_KEYS="k1:$(head -c 32 /dev/urandom | base64)"
export GATEWAY_DATABASE_FILE=./data/gateway.sqlite
pnpm start
```

Connect an upstream:

```bash
curl -sX POST http://127.0.0.1:8787/api/v1/connections \
  -H 'authorization: Bearer dev-key' -H 'content-type: application/json' \
  -d '{"mcp_url":"https://mcp.example.com/mcp","alias":"example"}'
```

The response carries a `connect_url`. Open it once in a browser, approve the
upstream, and the tools appear in every client pointed at
`http://127.0.0.1:8787/mcp`.

To move the servers you already have configured, use the migration CLI:

```bash
export GATEWAY_URL=http://127.0.0.1:8787 GATEWAY_API_KEY=dev-key
node apps/migration-cli/dist/main.js discover
node apps/migration-cli/dist/main.js import      # open one link per server
node apps/migration-cli/dist/main.js install
```

See [docs/migration.md](docs/migration.md) for the whole journey, including
`prune` and `rollback`.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/core` | Protocol types, JSON-RPC, MCP and OAuth models, error taxonomy |
| `packages/observability` | Structured logging with redaction, Prometheus metrics |
| `packages/security` | SSRF-hardened fetcher, envelope encryption, locks, signing keys |
| `packages/storage` | SQLite store, schema, tenant-scoped repositories |
| `packages/oauth` | Discovery, registration strategies, token client, token manager |
| `packages/mcp-client` | Southbound client: Streamable HTTP, legacy HTTP+SSE, probing |
| `packages/mcp-server` | Northbound Streamable HTTP server and session handling |
| `packages/federation` | Tool registry, routing, policy engine, audit, session manager |
| `packages/gateway` | Composition root, HTTP routes, background worker |
| `apps/gateway-api` | The gateway process |
| `apps/background-worker` | Token renewal, catalogue resync, reaping, key rewrap |
| `apps/migration-cli` | `umg-migrate`: discover, import, install, prune, rollback |
| `conformance/harness` | Mock authorization server, mock MCP server, gateway fixture |
| `conformance/tests` | The test matrix from section 19 of the brief |

## Documentation

- [Architecture](docs/architecture.md) — components, data model, request paths
- [OAuth flow](docs/oauth-flow.md) — discovery, registration, refresh, rotation
- [Threat model](docs/threat-model.md) — assets, adversaries, controls, residual risk
- [Compatibility](docs/compatibility.md) — the four support tiers and client notes
- [Operations](docs/operations.md) — configuration, deployment, metrics, runbooks
- [Migration](docs/migration.md) — moving existing MCP configurations behind the gateway

## Testing

```bash
pnpm test                                   # everything
npx vitest run conformance/tests/security.test.ts
```

The conformance suite runs the real gateway against mock authorization and MCP
servers over loopback HTTP: no network access and no mocking of the gateway's
own code. Every test in `conformance/tests` maps to a numbered requirement in
the engineering brief.
