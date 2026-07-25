# Compatibility

## What the gateway supports

MCP: initialization and capability negotiation, Streamable HTTP, legacy
HTTP+SSE where practical, `tools/list`, `tools/call`, `resources/list`,
`resources/templates/list`, `resources/read`, `resources/subscribe`,
`prompts/list`, `prompts/get`, `completion/complete`, `logging/setLevel`,
cursor pagination on every list method, notifications, cancellation, progress
notifications, server-to-client requests, the `MCP-Protocol-Version` header and
`MCP-Session-Id` sessions.

A completion is routed by its reference: the prompt name or resource URI the
client sends is the gateway's namespaced version, which identifies the upstream
that owns it, and the reference is rewritten to the upstream's own name before
being forwarded. An upstream with no completions capability yields an empty set
rather than an error, so one incapable server cannot fail a keystroke.

OAuth: authorization code with PKCE S256, refresh tokens and rotation, state
and issuer validation, redirect URI validation, scope negotiation, resource
indicators, authorization server metadata, protected resource metadata, client
ID metadata documents, dynamic client registration and preconfigured clients.

## Support tiers for upstream servers

### Tier 1 — fully automatic

The server is remote MCP over HTTP, publishes protected resource metadata,
points at an authorization server that publishes its own metadata, and supports
either client ID metadata documents or open dynamic client registration, with
authorization code and PKCE.

The user pastes a URL, a browser opens, they approve, and the connection is
live. No administrator involvement.

### Tier 2 — generic configuration required

The server supports standard OAuth but its authorization server requires a
client created through a developer portal. An administrator registers one
client per issuer:

```bash
curl -sX POST "$GATEWAY_URL/api/v1/oauth-client-configurations" \
  -H "authorization: Bearer $GATEWAY_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "issuer": "https://auth.example.com",
        "client_id": "gateway-client",
        "client_secret": "...",
        "token_endpoint_auth_method": "client_secret_basic"
      }'
```

Every user in the tenant then authorizes through the same generic flow. This is
configuration; no code is added for the provider.

### Tier 3 — static bearer token or headers

The server has no OAuth at all and expects a fixed credential. Supply it when
creating the connection:

```json
{
  "mcp_url": "https://mcp.internal.example/mcp",
  "alias": "internal",
  "headers": { "Authorization": "Bearer ..." }
}
```

The headers are encrypted in the vault under the `static_headers` purpose. The
gateway does not pretend these are OAuth credentials: the connection has no
issuer, no refresh cycle and no reauthorization link.

### Tier 4 — no compatible remote MCP endpoint

A service that exposes only a proprietary API cannot be reached generically.
Somebody has to publish an MCP server for it; that adapter lives outside the
gateway. Adding provider-specific code here would break the property that makes
the gateway useful.

## Local stdio servers

A hosted gateway cannot launch a program on the user's machine, so stdio
servers are out of scope. The migration CLI reports them and leaves their
configuration untouched, so they keep working directly.

A future local sidecar could bridge them into authenticated remote connections,
but it is deliberately not part of the remote-OAuth work.

## Downstream client notes

The gateway requires nothing of a client beyond a URL and a bearer credential.
The differences below only concern how the migration CLI writes each config
file.

| Client | Config file | Secret reference |
| --- | --- | --- |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` | `${env:NAME}` in `headers` |
| Claude Code | `~/.claude.json`, `.mcp.json` | `${NAME}` in `headers` |
| Claude Desktop | platform-specific `claude_desktop_config.json` | none — literal only |
| Codex | `~/.codex/config.toml`, `.codex/config.toml` | `bearer_token_env_var` |
| VS Code | `.vscode/mcp.json` | `${env:NAME}` in `headers` |

Claude Desktop cannot dereference an environment variable, so `umg-migrate
install` skips it unless `--inline-key` is passed, which writes the gateway key
into the file in plain text.

Codex needs `experimental_use_rmcp_client = true` for Streamable HTTP, and only
reads the flag when it appears before every `[mcp_servers.*]` table. The CLI
inserts it in the right place and takes the *name* of the environment variable
in `bearer_token_env_var`, never the token itself.

`conformance/tests/client-compatibility.test.ts` exercises Cursor, Claude Code,
Codex and a generic SDK client against a live gateway: each initializes,
receives the aggregate catalogue, routes tool calls correctly, keeps a distinct
session, and survives an upstream reauthorization without being reconfigured.

## Stream resumption

Messages on a session's event stream carry an `id`, and a client that
reconnects with `Last-Event-ID` is replayed everything after it from a
256-message window. A client that opens a stream without that header is sent
only what no stream has carried yet, so a fresh client does not receive the
history of a session it is only now joining. Per-request response streams carry
no ids: there is nothing to resume when the whole stream is one answer, and
labelling those events would promise otherwise.

## Protocol version negotiation

The gateway advertises the latest protocol revision it implements and accepts
an older revision a client asks for, echoing the negotiated version back and
requiring it on subsequent requests. A client that asks for a version the
gateway does not know receives the gateway's latest, per the specification.

## Transport fallback

An upstream is probed for Streamable HTTP first and legacy HTTP+SSE second. A
server that is protected answers `401` on both, so the transport cannot be
determined until the gateway holds a token; it therefore re-probes after
authorization and records what the server actually speaks. A server that speaks
neither is rejected as `NOT_AN_MCP_SERVER` rather than being left in a
half-connected state.

## Behaviour when things go wrong

The gateway is backend-only, so it returns a stable error code rather than
prose. The wording below is the copy a control-plane UI should show for each
one; the codes are what the API and the MCP error payloads carry.

| Situation | Code | Copy to show |
| --- | --- | --- |
| Server unreachable | `UPSTREAM_UNAVAILABLE` | "Unable to reach MCP server. Verify the URL or network access." |
| Not an MCP endpoint | `NOT_AN_MCP_SERVER` | "The endpoint did not complete MCP initialization." |
| Requires OAuth | `AUTHORIZATION_REQUIRED` | Discovery has already started; show the `connect_url` |
| Requires preregistration | `CLIENT_CREDENTIALS_REQUIRED` | A generic prompt for a client ID and optional secret |
| Refresh token revoked | `REAUTH_REQUIRED` | "Connection requires authorization again," with the reconnect link |
| One upstream unhealthy | `UPSTREAM_UNAVAILABLE` on that alias only | Every other connection keeps working |

A single failing upstream never takes the gateway down. Its connection is
marked `DEGRADED`, the rest of the catalogue is unaffected, and the background
worker retries it on the next pass.
