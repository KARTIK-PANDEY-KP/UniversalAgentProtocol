# conformance tests

## Responsibility

The suite that decides whether the gateway is correct. Each file covers one
capability end to end, against a real gateway process talking to controllable
mock upstreams over real HTTP.

These are the tests that catch what unit tests cannot: an authorization server
that rotates refresh tokens under a concurrent refresh, a client that sends an
older protocol version, a redirect that crosses an origin while carrying a
credential.

## Does not own

- Unit-level coverage. A rule with no protocol surface is tested inside its own
  module, next to the code.
- The mocks and fixtures, which belong to `@uap/conformance`.

## Public interface

None. This module is only ever run, never imported.

## Depends on

- `@uap/conformance` — the harness.
- `@uap/core`, `@uap/security`, `@uap/federation`, `@uap/gateway` — for the
  types and services under test.
- `@uap/migration-cli` — driven in-process by `migration.test.ts`.

## Data ownership

No tables. Every fixture gets a temporary database.

## Entry points

One file per capability:

- `discovery.test.ts` — RFC 9728 and RFC 8414 discovery, and metadata that is
  wrong in interesting ways.
- `oauth-registration.test.ts` — client ID metadata documents, dynamic
  registration, and operator pre-registration.
- `transport.test.ts` — Streamable HTTP, the legacy HTTP+SSE transport, and
  negotiation between them.
- `token-concurrency.test.ts` — concurrent refresh against a rotating server.
- `dpop.test.ts` — sender-constrained tokens.
- `gateway-auth.test.ts` — downstream authentication of the gateway itself.
- `federation.test.ts` — naming, catalogue sync, policy and audit.
- `interactivity.test.ts` — sampling, elicitation, cancellation and
  subscriptions.
- `security.test.ts` — isolation, SSRF, redaction and the threat model's
  claims.
- `client-compatibility.test.ts` — the quirks of real MCP clients.
- `background-worker.test.ts` — the periodic jobs.
- `migration.test.ts` — the CLI against realistic client configurations.
- `vertical-slice.test.ts` — one connection from consent to tool call.

## Invariants

- No network access and no credentials. Everything the suite talks to, it
  started.
- Every test is independent and may run in parallel with the others.
- A test asserts on observable behaviour — a response, a stored record, an
  emitted audit event — never on a private field.
- A fixed bug gets a test here first, named for the behaviour rather than the
  defect.

## Testing

```bash
pnpm --filter @uap/conformance-tests test
```

## Owners

`@platform`
