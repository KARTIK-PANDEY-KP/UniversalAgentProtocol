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
