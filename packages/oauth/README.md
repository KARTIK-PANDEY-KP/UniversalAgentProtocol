# oauth

## Responsibility

Everything OAuth, in both directions.

Southbound, the gateway is an OAuth *client* to upstream servers: it discovers
authorization servers, obtains a client identity, runs the authorization code
flow with PKCE, and keeps access tokens fresh. Northbound, the gateway is an
OAuth *resource server*: it verifies the access tokens downstream callers
present.

There are no provider-specific code paths. GitHub, Slack, Linear and Notion are
reached the same way as any other compliant server, through metadata discovered
at runtime.

## Does not own

- Which upstreams exist or which scopes they need. That is `@umg/federation`.
- Storage. Issuers, registrations, transactions and tokens are persisted
  through repositories `@umg/storage` declares.
- Outbound HTTP. Every request goes through `@umg/security`'s `safeFetch`.
- Deciding who a user is. The resource server verifies a token and reports what
  it says; provisioning belongs to the composition layer.

## Public interface

`@umg/oauth`, from `src/index.ts`.

- `discovery.ts` — protected resource metadata (RFC 9728) and authorization
  server metadata (RFC 8414), validated and cached.
- `registration.ts` / `client-metadata.ts` — obtaining a client identity, by
  client ID metadata document, dynamic registration (RFC 7591), or operator
  pre-registration.
- `pkce.ts` — the code verifier and challenge (RFC 7636).
- `token-manager.ts` — the authorization transaction, the code exchange, and
  refresh with single-flight locking.
- `token-client.ts` — the token endpoint itself: authentication methods,
  refresh, exchange and revocation.
- `client-assertion.ts` — `private_key_jwt` (RFC 7523).
- `dpop.ts` — sender-constrained tokens (RFC 9449), used when the authorization
  server advertises it.
- `resource-server.ts` — verification of inbound access tokens, with JWKS
  retrieval, signature and audience checks.
- `www-authenticate.ts` / `insufficient-scope.ts` — parsing challenges and
  turning `insufficient_scope` into an incremental authorization.
- `protocol-error.ts` — OAuth error responses as `GatewayError`.

## Depends on

- `@umg/core`
- `@umg/observability`
- `@umg/security`
- `@umg/storage`

## Data ownership

Logical owner of `oauth_issuers`, `oauth_client_registrations`,
`oauth_transactions`, `preconfigured_oauth_clients` and `dpop_keys`, all
reached through repositories declared in `@umg/storage`.

## Entry points

`src/index.ts`. In practice: `OAuthDiscoveryService`, `OAuthClientRegistrar`,
`OAuthTokenManager`, `ResourceServerAuthenticator`.

## Invariants

- Every authorization request carries PKCE, and `state` is single-use and
  bound to the transaction.
- When an authorization server advertises `authorization_response_iss_parameter_supported`,
  a response without a matching `iss` is refused (RFC 9207).
- Issuers are stored and compared in canonical form, so one issuer cannot
  become two records.
- Authorization server endpoints must be absolute and HTTPS unless HTTP is
  explicitly permitted for local development.
- One refresh happens per grant. Concurrent callers wait on a lock rather than
  racing, because a rotating server invalidates the loser's refresh token.
- A downstream caller never receives an upstream token, at any layer.
- Inbound JWTs must carry an access-token `typ`. An ID token presented as an
  access token is refused.
- Key-set refetches are bounded per issuer, so an unknown `kid` cannot be used
  to make the gateway hammer a JWKS endpoint.

## Testing

```bash
pnpm --filter @umg/oauth test
pnpm --filter @umg/conformance-tests test
```

The interesting cases are in the conformance suite, which runs against mock
authorization servers that can be told to misbehave.

## Owners

`@identity`
