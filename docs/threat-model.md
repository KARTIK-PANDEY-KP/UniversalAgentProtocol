# Threat model

The gateway is a credential broker. It holds long-lived refresh tokens for
every upstream a user has connected, and it fetches URLs those users supply.
Those two facts drive most of what follows.

## Assets

| Asset | Why it matters |
| --- | --- |
| Upstream refresh tokens | Long-lived access to a user's third-party accounts |
| Upstream access tokens | Immediate access until expiry |
| OAuth client secrets and registration access tokens | Let an attacker act as the gateway's OAuth client |
| The gateway's `private_key_jwt` signing key | Authenticates the gateway at token endpoints |
| PKCE verifiers and authorization codes | In-flight material that completes a grant |
| Gateway credentials | Access to every upstream connection at once |
| Tool catalogues and audit records | Reveal what a user's systems contain |

## Adversaries

- **A malicious or compromised upstream MCP server.** It controls tool
  descriptions, schemas and results, and can attempt SSRF through the URLs it
  advertises and prompt injection through the content it returns.
- **A malicious user of a shared deployment.** Tries to reach another tenant's
  connections, tools or tokens.
- **A network attacker.** Attempts DNS rebinding, redirect abuse, or replay of
  authorization responses.
- **An attacker with read access to storage or logs.** A stolen backup, a leaked
  log stream, a debugging dump.
- **A malicious downstream client.** Tries to obtain a raw upstream token or to
  use another client's session.

## Controls

### Token isolation

Upstream tokens never leave the gateway. There is no control-plane route that
returns one, no MCP result that embeds one, and no token in a redirect URL. The
gateway makes every upstream call itself, which is also what makes optional
DPoP support possible: sender-constrained tokens require possession of the key,
and the gateway keeps it.

A downstream gateway credential is never forwarded upstream, and an upstream
token is never sent to a resource other than the one it was minted for. The
`resource` parameter is included on both the authorization and token requests
so the authorization server can enforce this too.

*Verified by* `conformance/tests/security.test.ts`, which walks every
control-plane route asserting no response body contains stored token material.

### Encryption at rest

Envelope encryption with AES-256-GCM. A random data key encrypts the value, and
the data key is wrapped by a key-encryption key from the key ring. The tenant
ID and the field's purpose are bound as additional authenticated data, so a
ciphertext cannot be pasted from `refresh_token` into `access_token`, nor moved
from one tenant to another: decryption fails.

Ciphertexts record the key ID that sealed them. Rotating the ring means adding
a new active key while keeping the old one readable; the background worker's
rewrap job then moves every value onto the new key without changing the
plaintext or the token version, so a concurrent refresh still wins the
compare-and-swap it expects.

`LocalKeyring` is the development implementation. The `KeyProvider` interface
is two operations, `wrap` and `unwrap`, which a KMS or HSM implements without
any other change.

### SSRF

The gateway fetches URLs the user chose and metadata documents those URLs point
to. Every outbound request goes through `SafeFetcher`, which:

- requires HTTPS unless the deployment explicitly allows HTTP;
- classifies the resolved address before connecting and rejects loopback,
  private, link-local, unique-local and cloud metadata ranges;
- classifies **IP literals too**, not only DNS results. Node connects directly
  to a literal without consulting the DNS lookup hook, so a check that only
  hooks DNS is bypassed by writing `http://169.254.169.254/` — the fetcher
  therefore classifies the literal before the socket is opened;
- re-validates after every redirect and caps the redirect count at three;
- caps the response size and enforces expected content types;
- applies connection and read timeouts;
- optionally restricts a tenant to an allowlist of hosts.

Because classification happens per connection attempt rather than once per
hostname, a DNS rebinding attempt that returns a public address and then a
private one is caught on the second connection.

SSRF blocks are reported as `SSRF_BLOCKED` rather than being flattened into a
generic "server unavailable", so an operator can tell a policy violation from
an outage.

*Verified by* the SSRF section of `conformance/tests/security.test.ts`,
including the metadata-service literal and a redirect into a private range.

### Origin validation and DNS rebinding

The Streamable HTTP endpoint validates the `Origin` header against the
configured allowlist. A local or internal deployment is otherwise reachable
from any page the user visits, because the browser will happily send requests
to `127.0.0.1`.

### OAuth transaction integrity

Random state, PKCE S256, short expiry, single-use consumption, exact redirect
matching, issuer binding, resource binding and user binding. Consumption is an
atomic conditional update, so an authorization code replayed by an attacker
finds the transaction already consumed. State is indexed by hash, so database
read access does not yield a usable state value.

User binding applies whenever the callback carries a gateway credential. A
browser completing the flow often carries none, in which case the transaction's
own secrets are what protect it: the state is high-entropy, single-use and
stored only as a hash, and the code is worthless without the PKCE verifier the
gateway holds. An attacker who can read the redirect URL in flight can still
complete a grant the victim started, which is the reason the flow is short
lived and the reason `return_to` is restricted — see below.

The `return_to` a caller may attach to an authorization is checked against the
gateway's own origin plus `GATEWAY_RETURN_TO_ORIGINS`. Without that check a
tenant user could route victims through a genuine consent screen and out to a
page of their choosing, which is a far more convincing phish than a bare link.

### Multi-tenant isolation

Every query that touches credentials, sessions, tools or connections is scoped
by tenant. Encryption context includes the tenant. Locks are tenant-aware.
There is no shared decrypted token cache. A session ID from one principal is
not usable by another, even inside the same tenant: presenting it returns 404
rather than confirming that it exists.

### Tool-level policy

OAuth authorizes access to an MCP server; it says nothing about whether every
tool that server exposes is safe. Tools are classified as `READ_ONLY`, `WRITE`,
`DESTRUCTIVE`, `EXTERNAL_COMMUNICATION`, `FINANCIAL`, `ADMINISTRATIVE` or
`UNKNOWN` from their name, description and annotations. By default a tool that
looks destructive but carries no `destructiveHint` annotation is not exposed at
all, and destructive or financial tools require confirmation per call.

Arguments are validated against the tool's declared JSON Schema and capped at
256 KiB; results are capped at 4 MiB. Operators can disable individual tools,
block whole risk classes, and restrict write-class tools by role.

Classification tokenizes the tool name first, so `delete_repository` and
`deleteRepository` are both recognised — a word-boundary match against the raw
name misses both.

### Untrusted upstream content

Everything an upstream returns is untrusted data. Tool results are never parsed
for instructions, never used to select a connection or a tenant, and never able
to change policy, approval rules or trigger further tool calls. Server-to-client
requests such as sampling and elicitation are checked against policy, routed
only to the downstream session that caused them, and rejected with a valid MCP
error when the client did not advertise the capability. Request IDs are
translated between the two sessions rather than passed through.

### Logging

Every log record passes through a redaction pass covering bearer tokens, JWTs,
authorization codes, PKCE verifiers, client secrets and key material, in field
values and in free-form message text. Logs carry tenant, connection, issuer,
operation, correlation ID, error class and timing — enough to debug a failure
without reproducing the credential that caused it.

*Verified by* two tests: one asserting a full successful flow writes no
sensitive value, and one feeding known secret shapes directly to the logger.

### Session lifecycle

Downstream and upstream sessions are reaped after an idle window. An upstream
that returns `404` for a session ID causes the gateway to discard it and
reinitialize; only idempotent operations are retried automatically. Destructive
tool calls are never replayed without an idempotency guarantee.

## Residual risks

**A compromised gateway is a compromise of every connected upstream.** This is
inherent to central credential brokering. Mitigations are operational: KMS or
HSM-backed keys so a database leak alone is insufficient, short access token
lifetimes, per-tenant encryption context, audit logging, and revocation.

**Prompt injection reaching the user's model.** The gateway prevents upstream
content from affecting the *gateway*, but it cannot prevent a downstream model
from acting on text an upstream returned. Defence belongs partly to the client.
The gateway's contribution is confirmation gates on destructive tools and audit
records for every call.

**The client ID metadata document depends on continued control of the domain.**
If the gateway's domain lapses, whoever acquires it inherits an OAuth client
identity that authorization servers already trust. Treat the domain, the
document and the JWKS endpoint as production infrastructure: monitor
availability, never let registration lapse, and rotate signing keys with an
overlap window during which the retired public key is still published.

**Downstream authentication is only as strong as it is configured to be.** The
MVP shared API key gives no per-user attribution. Production deployments should
protect the gateway as an OAuth resource so each application holds its own
token while resolving to the same user and the same upstream connections.
