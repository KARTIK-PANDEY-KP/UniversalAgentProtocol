# conformance harness

## Responsibility

Everything a test needs to stand a whole gateway up and point it at
controllable upstreams: mock authorization servers, mock MCP servers, a mock
identity provider, a headless browser agent that completes consent screens, a
gateway fixture, and readers for the streaming responses.

The mocks are deliberately hostile. Each one can be told to omit a required
parameter, rotate a refresh token, expire a secret, return the wrong issuer, or
speak an older transport, because the behaviour worth testing is what the
gateway does when a server misbehaves.

## Does not own

- Any assertion. Tests live in `conformance/tests`; the harness only makes them
  possible.
- Production behaviour. Nothing here ships, and no module outside
  `conformance/` may depend on it.

## Public interface

`@uap/conformance`, from `src/index.ts`.

- `mock-authorization-server.ts` — an RFC 8414 authorization server with knobs
  for PKCE, DCR, token rotation, DPoP, issuer echo and expiring secrets.
- `mock-identity-provider.ts` — mints JWTs for downstream gateway
  authentication, including deliberately wrong ones.
- `mock-mcp-server.ts` — an upstream MCP server on either transport, with a
  configurable catalogue and protocol violations on demand.
- `gateway-fixture.ts` — a gateway on an ephemeral port with a temporary
  database.
- `gateway-mcp-client.ts` — a downstream MCP client for driving `/mcp`.
- `browser.ts` — the agent that completes an authorization flow.
- `dpop-verifier.ts` — checks DPoP proofs the way a real server would.
- `http-fixture.ts`, `sse-reader.ts`, `scenario.ts` — plumbing.

## Depends on

- `@uap/core`
- `@uap/observability`
- `@uap/gateway`

## Data ownership

No tables. Each fixture gets a temporary SQLite file it deletes on teardown.

## Entry points

`src/index.ts`.

## Invariants

- Every fixture binds an ephemeral loopback port and releases it on teardown,
  so the suite runs in parallel and needs no network access.
- No test requires credentials or reaches a real provider.
- A mock's default behaviour is the compliant one. Misbehaviour is always
  opt-in at the call site, so a test that exercises it says so.

## Testing

The harness is exercised by the suite that uses it:

```bash
pnpm --filter @uap/conformance-tests test
```

## Owners

`@platform`
