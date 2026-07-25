# mcp-client

## Responsibility

Speaking MCP to an upstream server: probing which transport it supports,
opening a session, sending requests, and surfacing the notifications and
server-initiated requests that come back.

Transport variety lives here and stops here. An upstream may want Streamable
HTTP or the older HTTP+SSE transport; callers above this module see one
`UpstreamMcpConnection` either way.

## Does not own

- Credentials. A connection is handed the headers to use and never learns where
  they came from or how to renew them.
- What to do with an upstream's catalogue. Discovery and federation belong to
  `@umg/federation`.
- Retry policy across reconnects. This module reconnects a stream; deciding a
  connection is unhealthy is the caller's call.

## Public interface

`@umg/mcp-client`, from `src/index.ts`.

- `probe.ts` — negotiating which transport an upstream actually supports.
- `transport.ts` — the transport interface both implementations satisfy.
- `streamable-http.ts` — the current MCP transport.
- `legacy-sse.ts` / `sse.ts` — the older HTTP+SSE transport, and SSE framing.
- `connection.ts` — `UpstreamMcpConnection`: initialize, request, notify, and
  the event stream.

## Depends on

- `@umg/core`
- `@umg/observability`
- `@umg/security`

## Data ownership

No tables. Sessions live in memory; whether one is worth persisting is decided
above this module.

## Entry points

`src/index.ts`, then `probeTransport()` and `UpstreamMcpConnection`.

## Invariants

- Requests go out through `safeFetch`. There is no other outbound path.
- A 401 is reported to the caller with the `WWW-Authenticate` challenge intact,
  because that challenge is what drives incremental authorization upstairs.
- A closed connection rejects every pending request. A caller is never left
  waiting on a response that can no longer arrive.
- Stream reconnection resumes from the last event id when the server offers
  one, and reports a gap when it cannot.
- A session the upstream no longer holds is rebuilt rather than retried against.
  The spec words that refusal as a 404 and the reference server words it as a
  400 once it has restarted; both are read the same way, and the id that earned
  the refusal is never presented again.
- Protocol version negotiation follows the upstream's answer, not a hardcoded
  assumption.

## Testing

```bash
pnpm --filter @umg/conformance-tests test
```

Exercised against the mock MCP servers in the harness, which can be configured
for either transport and for protocol violations.

## Owners

`@protocol`
