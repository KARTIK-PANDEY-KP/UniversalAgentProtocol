# OAuth flow

The gateway is an OAuth client of every upstream authorization server, using
its own identity. It never reuses another application's client ID, metadata
document, registration or keys.

Standards implemented: RFC 6749 (authorization code), RFC 7636 (PKCE S256),
RFC 8414 (authorization server metadata), RFC 8707 (resource indicators),
RFC 9728 (protected resource metadata), RFC 7591 (dynamic client
registration), and the client ID metadata document mechanism from the MCP
authorization specification.

## Discovery

Adding an upstream starts with an unauthenticated `initialize`. Four things can
come back, and each leads somewhere different.

| Result | What happens |
| --- | --- |
| `initialize` succeeds | The server needs no authorization; the catalogue is discovered immediately |
| `401` with `WWW-Authenticate` | Discovery proceeds from the challenge |
| A non-MCP response | `NOT_AN_MCP_SERVER`, surfaced to the user as "the endpoint did not complete MCP initialization" |
| Connection failure | `UPSTREAM_UNAVAILABLE` |

From the challenge the gateway reads `resource_metadata` and any advertised
`scope`. It fetches the protected resource metadata document, validates that
its `resource` matches the MCP URL it was reached at, and reads the list of
authorization servers. When the challenge carries no `resource_metadata`, the
gateway falls back to the well-known path derived from the MCP URL.

Each candidate issuer is then resolved through `/.well-known/oauth-authorization-server`
(or OIDC discovery). The response must declare an `issuer` that matches the URL
it was fetched from; a mismatch is `ISSUER_MISMATCH` and the connection stops
there. Metadata is cached with its ETag and expiry so a repeated connection
does not re-fetch it.

Everything discovered is bound to `(tenant, issuer, canonical resource)`. The
MCP hostname alone is never the key.

## Choosing a client identity

`RegistrationSelector` tries four strategies in order and uses the first that
supports the authorization server.

**1. Preconfigured.** An administrator has already registered an OAuth client
for this issuer through `POST /api/v1/oauth-client-configurations`. The client
secret is encrypted in the vault. This is configuration, not a provider
integration: the same code consumes it whichever service it belongs to.

**2. Client ID metadata document.** The authorization server advertises
`client_id_metadata_document_supported`. The gateway's own document URL becomes
the `client_id`:

```
https://gateway.example.com/oauth/client-metadata.json
```

The document is served from `/oauth/client-metadata.json` and its `client_id`
is exactly that URL. It declares `private_key_jwt` and points at
`/.well-known/jwks.json`, so token requests are signed rather than
authenticated with a shared secret.

**3. Dynamic client registration.** The authorization server advertises a
`registration_endpoint`. The gateway registers itself, stores the resulting
credentials against `(tenant, issuer)`, and keeps the registration access token
encrypted for later management. A registration issued by one authorization
server is never presented to another.

**4. User-supplied.** Nothing automatic is available. The connection is marked
`CLIENT_CREDENTIALS_REQUIRED` and the user is asked, generically, for a client
ID and optional secret. No provider-specific instructions are shown.

The token endpoint authentication method is chosen from what the server
advertises, preferring `private_key_jwt`, then `client_secret_basic`, then
`client_secret_post`, then `none`.

## Authorization

The gateway creates a transaction holding the state, the PKCE verifier, the
issuer, the canonical resource, the redirect URI, the connection, the acting
user and an expiry. The verifier is encrypted at rest and never logged. Only
the SHA-256 of the state is indexed, so a stolen database row does not yield a
usable state value.

The authorization URL carries:

```
response_type=code
client_id=<selected client id>
redirect_uri=https://gateway.example.com/oauth/callback
state=<random>
code_challenge=<S256 of the verifier>
code_challenge_method=S256
resource=<canonical MCP resource>
scope=<requested scopes>
```

`resource` is what keeps a token minted for one MCP server from being usable at
another. It is sent on both the authorization request and the token request.

## The callback

`GET /oauth/callback` consumes the transaction exactly once. Before exchanging
anything it checks that the transaction exists and has not expired, that the
state matches, that any `iss` parameter equals the expected issuer, that the
redirect URI is the one that was registered, that the connection still exists,
and that the acting user matches the one who started the flow. Consumption is
an atomic update, so a replayed authorization code finds nothing to consume.

The code is then exchanged with `code_verifier`, the exact `redirect_uri` and
the same `resource`. The gateway authenticates itself using whichever method
was selected during registration.

## What is stored

Access token, refresh token, token type, expiry, granted scopes, resource,
issuer, the registration that was used, the token version and the connection
status. Access and refresh tokens are encrypted separately, each bound to the
tenant and to its own purpose.

If the authorization server issues no refresh token, the connection becomes
`CONNECTED_NON_REFRESHABLE`. It works until the access token expires and then
requires a new authorization flow, rather than silently failing.

## Refresh

Before every upstream request:

```
if the access token has more than the safety window left:
    use it
else:
    take the connection lock, re-read, and refresh if still stale
```

The safety window defaults to 60 seconds. Callers can ask for more headroom:
the background worker asks for five minutes so an interactive tool call rarely
waits on an authorization server.

Inside the lock the connection is re-read, because another worker may already
have refreshed it. The write is a compare-and-swap on `token_version`. When the
server returns a rotated refresh token, the replacement is atomic: there is
never a moment where both the old and the new refresh token are stored.

## Sender-constrained tokens (DPoP)

When an authorization server advertises `dpop_signing_alg_values_supported`
containing `ES256`, the gateway generates a P-256 key pair for the connection
before the authorization request and binds the grant to it. The private key is
encrypted in the vault under its own purpose and never leaves the process
decrypted; only the public JWK is stored in the clear.

Every request the bound grant is used for — the code exchange, each refresh,
and each upstream MCP call — carries a fresh `DPoP` proof JWT covering the
method and URI of that one request. Requests carrying an access token also
carry its `ath` hash, so a proof captured from one request cannot be attached
to a different token.

The token endpoint and the resource server may each refuse the first proof with
`use_dpop_nonce` and a `DPoP-Nonce` header purely to hand out a nonce. That is
one prescribed round trip, not a failure: the gateway records the nonce per
endpoint and retries once with it. Nonces the resource server rotates mid-
session are picked up the same way.

The token type the server returns decides how the token is presented
downstream of this decision: a bound token is sent as `Authorization: DPoP …`,
an unbound one as `Bearer`. The gateway never guesses — a server that does not
advertise DPoP gets bearer tokens, and a connection that already has a key
drops it if the server stops advertising support.

The binding key outlives the tokens minted with it, so a refresh does not
invalidate proofs already in flight.

*Verified by* `conformance/tests/dpop.test.ts`, which includes replaying a
bound token as a bearer token and confirming the resource server refuses it.

## Widening a grant

An upstream may refuse one tool while happily serving another, because the
token is missing a scope that tool needs. RFC 6750 spells this as a `403` with
`WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`; some servers
take the shortcut of failing the JSON-RPC call and naming the error in the
message. The gateway reads both.

The response is not to retry and not to silently drop the grant it already has.
The union of the currently granted scopes and the newly required ones is
recorded on the connection as the scopes to request next, the connection moves
to `REAUTH_REQUIRED`, and the caller receives a reconnect prompt. The existing
grant is left untouched until the user completes the wider authorization, so
tools that worked before keep working in the meantime.

## Failure handling

**`invalid_grant`** means the grant is gone: revoked, expired, or a rotation
replay was detected. The connection becomes `REAUTH_REQUIRED`. Downstream
clients receive a structured MCP error carrying a `reconnect_url` and nothing
else — no provider credential and no internal detail.

**`invalid_client`** means the client identity was rejected: a dynamic
registration expired, or a secret did. The gateway does not silently replace an
approved identity; it re-registers only where that is safe and otherwise
requires reconnection.

**Transient failures** are retried with bounded exponential backoff and jitter.
The refresh token is preserved: a network timeout is not consent revocation, so
the connection is marked `DEGRADED` rather than `REAUTH_REQUIRED`, and it
returns to `CONNECTED` when the provider recovers. A circuit breaker opens
after repeated failures so an outage at one authorization server does not turn
into a retry storm; while it is open no request reaches the provider at all.

## Revocation

Deleting a connection calls the authorization server's revocation endpoint with
the refresh token when one is advertised, then clears the stored credentials.
Failure to reach the endpoint does not block the local deletion, but it is
logged.

## The gateway as a protected resource

Everything above describes the gateway acting as an OAuth *client*. It is also
an OAuth *resource server*: `/.well-known/oauth-protected-resource` names the
issuers whose access tokens it accepts, and both `/mcp` and the control plane
validate them.

Set `GATEWAY_AUTHORIZATION_SERVERS` to turn this on. A gateway API key is still
checked first, so the two credentials coexist; where no issuer is configured the
token path is skipped entirely rather than failing open.

A presented JWT has to clear all of the following before it becomes a principal.

| Check | Why it is there |
| --- | --- |
| `alg` is asymmetric | `none` and the HMAC family would let anyone who read the metadata mint a token |
| `iss` is a configured issuer | Trust is enumerated, not inferred from the token |
| Signature verifies against the issuer's JWKS | An unknown `kid` triggers one refetch, so a key rotation does not lock everyone out |
| `exp` is present and in the future | A token with no expiry never stops being useful to whoever steals it |
| `aud` contains `${GATEWAY_BASE_URL}/mcp` | Without this, any token from a shared authorization server unlocks the gateway — the confused deputy the audience check exists to prevent |
| `scope` includes one of `GATEWAY_REQUIRED_SCOPES` | Defaults to the scopes the metadata advertises, so the two agree |

Rejections come back as RFC 6750 challenges rather than a bare `401`: an expired
token gets `error="invalid_token"`, a token that is merely too narrow gets a
`403` with `error="insufficient_scope"` and the scope it needs. A client that is
told only "unauthorized" cannot tell those apart, and retries the wrong recovery.

The subject becomes a workspace member on first sight. The tenant comes from the
`GATEWAY_TENANT_CLAIM` claim (falling back to `GATEWAY_DEFAULT_TENANT`), the role
from `GATEWAY_ROLES_CLAIM`, and the user ID is the subject prefixed by the
issuer's host — two authorization servers may both mint `sub: "1"`, and without
the prefix the second would inherit the first's connections.

*Verified by* `conformance/tests/gateway-auth.test.ts`.
