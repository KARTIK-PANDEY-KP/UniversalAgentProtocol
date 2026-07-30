# mcp-server

## Responsibility

The northbound half of the gateway: the MCP server that Cursor, Claude Code,
Codex and anything else compliant connect to. It owns the HTTP endpoint, the
Streamable HTTP transport, session lifecycle, and the framing of responses and
server-initiated messages.

It handles the protocol. It does not know what a tool is for.

## Does not own

- Any MCP method's meaning. Requests are handed to a handler that
  `@uap/federation` supplies.
- Authentication. The composition layer authenticates a request before this
  module sees it.
- Upstream anything. This module only ever faces downstream clients, and
  routing to upstreams is `@uap/federation`.

## Public interface

`@uap/mcp-server`, from `src/index.ts`.

- `http.ts` — the `/mcp` endpoint: POST for requests, GET for the server-to-
  client stream, DELETE to end a session.
- `session.ts` — session identity, expiry, and per-session state.
- `northbound-server.ts` — the JSON-RPC layer: dispatch, error mapping, and
  delivery of notifications and server-initiated requests.

## Depends on

- `@uap/core`
- `@uap/observability`
- `@uap/security`

## Data ownership

Logical owner of `downstream_mcp_sessions`, reached through a repository
declared in `@uap/storage`.

## Entry points

`src/index.ts`, then `NorthboundMcpServer` and its HTTP handler.

## Invariants

- One session per client. Sessions are independent: two clients sharing an
  upstream grant still get separate transports, cursors and log levels.
- `Mcp-Session-Id` is issued at `initialize` and required afterwards. An
  unknown one gets 404, so a client re-initializes rather than guessing.
- `Origin` is validated on browser-reachable requests.
- A batch containing `initialize` is refused rather than partly applied.
- Malformed JSON-RPC produces a JSON-RPC error, not a transport error.
- The GET stream is single: a second one for the same session is refused, so
  server-initiated messages have exactly one place to arrive.

## Testing

```bash
pnpm --filter @uap/conformance-tests test
```

The client-compatibility tests drive this module the way real clients do,
including the ones that do not follow the specification closely.

## Owners

`@protocol`
