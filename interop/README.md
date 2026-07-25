# interop

## Responsibility

Running the gateway against implementations nobody here wrote: the official MCP
SDK on both sides, a certified OpenID Connect provider, and MCP servers on the
public internet. The conformance suite proves the gateway matches our reading
of the specifications; this rig checks that reading against the world.

It is a manual harness, not part of CI. It needs outbound network access, binds
half a dozen local ports, and takes a couple of minutes because it waits out
real token expiry.

## Does not own

- Correctness of any single module. That is the conformance suite's job, and a
  bug found here should leave behind a test there before it is fixed.
- Anything the gateway ships. Nothing under `packages/` or `apps/` may import
  from this directory, and nothing here is published.

## Public interface

Two entry points, both run by hand:

- `node rig.mjs up | down | status | restart <name>` — the processes.
- `node run-all.mjs [suite...]` — the suites.

## Depends on

The built gateway (`pnpm build` at the repository root), and its own
`node_modules`, installed separately because this is not a workspace package:

```bash
cd interop && npm install
```

- `@modelcontextprotocol/sdk` — the reference client and server.
- `@modelcontextprotocol/server-everything` — the SDK's own exhaustive server.
- `oidc-provider` — a certified OpenID Connect authorization server.

## Data ownership

Everything transient lives in `.run/`: pid files, logs, and the gateway's
SQLite database. `rig.mjs up` deletes the database first, so an attach is
always a first attach. The directory is not tracked.

## Entry points

```bash
pnpm build            # from the repository root
cd interop
npm install
node rig.mjs up       # starts everything and attaches the upstreams
node run-all.mjs      # runs every suite
node rig.mjs down
```

### What comes up

| Process | Port | What it is |
| --- | --- | --- |
| `gateway` | 8801 | The gateway under test |
| `ref` | 8811 | An SDK server, unauthenticated |
| `secure` | 8812 | An SDK server as a real OAuth 2.0 resource server |
| `everything` | 8813 | The SDK's `server-everything` |
| `proxy` | 8821 | Logging proxy in front of the provider |
| `oidc` | 8823 | `oidc-provider`, reached through the proxy |

The provider sits behind the proxy so its issuer identity stays fixed while
every token, registration and introspection request can be read back verbatim
from `.run/proxy.log` when something fails. Three public servers — DeepWiki,
GitMCP and Context7 — are attached over the internet alongside the local ones.

### The suites

- `protocol` — the official SDK client against the gateway: initialize, tools,
  resources, prompts, pagination, progress, error codes, shutdown.
- `federation` — every upstream at once, name collisions, schemas, concurrency.
- `bidirectional` — the awkward direction: sampling, elicitation, roots,
  logging and resource subscriptions travelling from upstream to client.
- `resilience` — an upstream dies, comes back, the gateway restarts, and a
  hundred calls arrive together.
- `token-lifecycle` — an access token expiring, a rotating refresh token, and a
  grant revoked at the provider. Slow: it waits out real 30 second tokens.

## Testing

This directory is the test. To check the rig itself still works after changing
the gateway:

```bash
node rig.mjs up && node run-all.mjs
```

A suite exits non-zero on the first failing check, and `run-all.mjs` prints a
summary of which suites passed.

## Owners

`@protocol`
