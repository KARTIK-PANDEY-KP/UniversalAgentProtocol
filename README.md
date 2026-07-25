# Universal Agent Protocol

An agent is more than a model: it is the tools it can reach, the credentials it
holds, the skills it has been taught and the rules it works under. Today each
of those is re-solved from scratch inside every application, so an agent's
abilities are trapped in whichever product configured them. UAP is the project
for making them portable — defined once, carried between applications.

The first piece is the hard one, and it is what this repository ships now:
**connections**. Everything else an agent gains is worthless if it cannot
authenticate as you, and today authenticating means every application repeating
every OAuth flow and holding a copy of every credential.

## Connections: the gateway

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

See [docs/operations/migration.md](docs/operations/migration.md) for the whole journey, including
`prune` and `rollback`.

## Repository layout

The codebase is a modular monolith: one process, divided into workspace
packages that may only reach each other through a published interface, in one
direction, enforced on every pull request. [ARCHITECTURE.md](ARCHITECTURE.md)
explains the rules and where new code goes; each directory below has a README
answering the same questions for itself.

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
| `apps/migration-cli` | `uap-migrate`: discover, import, install, prune, rollback |
| `conformance/harness` | Mock authorization server, mock MCP server, gateway fixture |
| `conformance/tests` | The test matrix from section 19 of the brief |
| `interop` | Manual rig: the gateway against real SDKs, a real OAuth provider and live servers |
| `tooling/architecture` | The check that enforces the module boundaries |

## Documentation

[docs/](docs/README.md) is the index. The short version:

- [Getting started](docs/getting-started/running-locally.md) — run it, connect an upstream, point a client at it
- [Architecture](docs/architecture/overview.md) — components, data model, request paths
- [OAuth flow](docs/architecture/oauth-flow.md) — discovery, registration, refresh, rotation
- [Threat model](docs/architecture/threat-model.md) — assets, adversaries, controls, residual risk
- [Configuration](docs/reference/configuration.md) — every environment variable
- [Compatibility](docs/reference/compatibility.md) — the four support tiers and client notes
- [Operations](docs/operations/running.md) — deployment, metrics, alerting, runbooks
- [Migration](docs/operations/migration.md) — moving existing MCP configurations behind the gateway
- [Decisions](docs/decisions/) — what was decided, what was rejected, what it cost

Contributing: [ARCHITECTURE.md](ARCHITECTURE.md) for how the code is organised,
[CONTRIBUTING.md](CONTRIBUTING.md) for how to work in it.

## Testing

```bash
pnpm test                                   # everything
npx vitest run conformance/tests/security.test.ts
```

The conformance suite runs the real gateway against mock authorization and MCP
servers over loopback HTTP: no network access and no mocking of the gateway's
own code. Every test in `conformance/tests` maps to a numbered requirement in
the engineering brief.

Mocks only prove the gateway matches our reading of the specifications, so
[interop/](interop/README.md) checks that reading against implementations
nobody here wrote: the official MCP SDK on both sides, a certified OpenID
Connect provider, and MCP servers on the public internet. It needs network
access and a couple of minutes, so it is run by hand rather than in CI.

```bash
pnpm build && cd interop && npm install
node rig.mjs up && node run-all.mjs
```
