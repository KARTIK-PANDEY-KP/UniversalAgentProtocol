# Architecture

## The two protocol roles

The gateway speaks MCP in both directions and is an OAuth client in one of
them.

```
Cursor / Claude Code / Codex / cloud agents
        │  MCP client  →  MCP server
        ▼
┌──────────────────────────────────────────────┐
│ Universal Agent Protocol Gateway                        │
│                                              │
│  northbound MCP server   (packages/mcp-server)
│  tool federation         (packages/federation)
│  OAuth engine + vault    (packages/oauth, packages/security)
│  southbound MCP client   (packages/mcp-client)
└──────────────────────────────────────────────┘
        │  MCP client  →  MCP server
        │  OAuth client → authorization server
        ▼
GitHub MCP / Slack MCP / any remote MCP server
```

Nothing in the gateway knows what a GitHub issue or a Slack channel is. An
upstream is a URL that speaks MCP; its authorization requirements are
discovered at runtime from the challenge it returns.

## Packages

Each package is a TypeScript project reference with no global state, so it can
be exercised on its own. Dependencies point one way, from `core` outwards.

**`packages/core`** holds the vocabulary: JSON-RPC envelopes, MCP request and
result shapes, OAuth metadata types, the domain records the store persists, and
`GatewayError` with its mapping to HTTP statuses and JSON-RPC codes. Everything
else depends on it and it depends on nothing.

**`packages/observability`** provides the structured logger, the redaction pass
every log record goes through, and the Prometheus registry. Metric names live
in one file so the operations documentation cannot drift from the code.

**`packages/security`** is where the dangerous work happens. `SafeFetcher`
performs every outbound HTTP request the gateway makes on behalf of a user:
it classifies the resolved address before connecting, re-validates on each
redirect, caps the response size and enforces content types. `CredentialVault`
seals secrets with envelope encryption, binding tenant and purpose as
additional authenticated data so a ciphertext cannot be moved between fields or
between tenants. The package also holds the distributed lock primitive, the
JWKS signing key store and origin validation.

**`packages/storage`** is a SQLite implementation of a repository interface.
Every credential-bearing query is scoped by tenant, and token writes go through
a compare-and-swap on `token_version`. Swapping in Postgres means implementing
`GatewayStore`; nothing above this layer writes SQL.

**`packages/oauth`** contains the standards work: parsing `WWW-Authenticate`,
fetching protected resource and authorization server metadata, the four client
registration strategies, PKCE, `private_key_jwt` client assertions, the token
endpoint client, and `OAuthTokenManager`, which owns authorization transactions
and the refresh coordinator.

**`packages/mcp-client`** is the universal southbound client. It implements
Streamable HTTP and the legacy HTTP+SSE transport, probes an unknown endpoint
to decide which one it speaks, and handles session expiry and reinitialization.

**`packages/mcp-server`** is the northbound Streamable HTTP server: origin
validation, protocol version negotiation, session assignment, request streams
that can carry progress notifications, and server-to-client requests.

**`packages/federation`** turns several upstreams into one catalogue. It
namespaces tools by connection alias, resolves collisions, detects schema
changes, routes calls, classifies tool risk, applies policy and records audit
events. `UpstreamSessionManager` owns the upstream session per
`connection + downstream session` pair.

**`packages/gateway`** is the composition root. It constructs every dependency
explicitly, registers the HTTP routes, and hosts the background worker.

## Request paths

### A downstream tool call

1. `POST /mcp` arrives with a gateway credential and an `MCP-Session-Id`.
2. The northbound server validates the origin, authenticates the principal and
   resolves the session.
3. `GatewayMcpHandler` looks up the routing record for `alias.tool_name`,
   scoped to the caller's tenant.
4. `PolicyEngine` checks that the tool is enabled, that the caller's role may
   call it, that the arguments fit the schema and the size limit, and whether
   the risk class needs confirmation.
5. `OAuthTokenManager.getValidAccessToken` returns a usable upstream access
   token, refreshing under a connection-scoped lock if needed.
6. `UpstreamSessionManager` acquires the upstream session for this connection
   and this downstream session, initializing it if the upstream dropped it.
7. The upstream call runs. Progress notifications are routed back to the
   originating request's stream, never broadcast.
8. The result is size-checked, audited and returned. Only the result crosses
   back down; the token never does.

A call in flight can be stopped from either end. A `notifications/cancelled`
naming the request aborts it, and so does the client simply hanging up. Either
way the abort propagates to the upstream call, which sends its own
cancellation onward, so the far end stops working rather than being quietly
abandoned. A cancellation that loses the race and arrives after the response is
ignored, which is what the specification asks for.

Requests the upstream initiates — `sampling/createMessage`,
`elicitation/create`, `roots/list` — travel the same path in reverse. They are
routed to the one downstream session that triggered the call, never broadcast,
and are refused when gateway policy disallows the method or the connected
client never advertised the capability. Resource subscriptions work the same
way: the subscription is placed upstream under the real URI, and the
`notifications/resources/updated` that comes back is rewritten to the
namespaced URI the client knows.

Two client-side messages travel outward rather than inward.
`logging/setLevel` is recorded on the downstream session and pushed to every
upstream that declared a logging capability, including upstreams opened after
the level was set — which is the usual order, since clients set the level
immediately after `initialize` and open their first upstream on the first tool
call. Upstreams that ignore the level are corrected on the way back: a
`notifications/message` below the client's floor is dropped at the gateway.
`notifications/roots/list_changed` is relayed to the session's upstreams,
because the gateway advertises `roots.listChanged` to each of them on its
client's behalf.

### Adding an upstream

`POST /api/v1/connections` canonicalizes the URL, probes the endpoint,
and either connects immediately (no authorization required) or records an
`AUTHORIZATION_REQUIRED` connection and returns a browser link. See
[oauth-flow.md](oauth-flow.md) for what happens behind that link.

After authorization the connection service re-probes the endpoint with the
access token in hand. This matters: before authorization both transports answer
`401`, so the first probe cannot tell Streamable HTTP from legacy HTTP+SSE. The
second probe records the transport the upstream actually speaks.

## Data model

The SQLite schema mirrors section 11 of the brief:

`tenants`, `users`, `mcp_servers`, `oauth_issuers`,
`oauth_client_registrations`, `upstream_connections`, `oauth_transactions`,
`discovered_tools`, `discovered_resources`, `discovered_prompts`,
`downstream_mcp_sessions`, `upstream_mcp_sessions`, `audit_events`,
`preconfigured_oauth_clients`, `distributed_locks`.

Three properties are worth calling out.

**No provider columns.** There is no `is_slack` or `github_organization`. What
distinguishes one upstream from another is its canonical URL, its issuer and
the capabilities it advertised.

**Registrations are keyed by issuer, not by hostname.** An OAuth client
registered dynamically with one authorization server is meaningless at another,
so `oauth_client_registrations` is keyed by `(tenant, issuer)`. If an MCP
resource changes issuer, its old credentials are not reused.

**Tokens carry a version.** `upstream_connections.token_version` is the
compare-and-swap key. A refresh that loses the race writes nothing rather than
clobbering a newer token pair.

## Session model

A downstream session belongs to one connected application. An upstream session
belongs to one `(connection, downstream session)` pair by default, so state a
stateful upstream keeps for Cursor cannot leak into the Codex session. Both are
reaped by the background worker when idle.

Sharing happens at the grant, not at the transport: three downstream sessions
can resolve to one upstream OAuth grant, and the conformance suite asserts that
the authorization server sees exactly one code exchange for all three.

## Concurrency

Two mechanisms keep concurrent traffic honest.

A **connection-scoped distributed lock** serializes token refresh. The first
caller to find an expired token takes `oauth-refresh:<connectionId>`, re-reads
the connection inside the lock, and refreshes only if it is still stale.
Everyone else waits and then observes the new token. The conformance suite
races a hundred callers and asserts exactly one provider refresh.

A **compare-and-swap on `token_version`** makes the write safe even if a lock
were lost, for example across a process restart. Rotated refresh tokens replace
their predecessor atomically; the old one is never left usable in storage.

The background worker uses both paths, so a scheduled renewal running beside a
live request cannot rotate a refresh token twice.
