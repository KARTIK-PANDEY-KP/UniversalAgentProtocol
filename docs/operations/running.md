# Operations

## Processes

Two processes share one database.

`apps/gateway-api` serves the MCP endpoint, the control plane and the OAuth
callback. It binds `HOST:PORT`, defaulting to `0.0.0.0` and the value of
`PORT`, which is what container platforms expect.

`apps/background-worker` runs the periodic jobs and listens on no port. Several
replicas may run at once: every job takes the same connection-scoped lock and
compare-and-swap the request path uses. `--once` runs a single deterministic
pass, for a cron scheduler or a manual check.

```bash
node apps/gateway-api/dist/main.js
node apps/background-worker/dist/main.js
node apps/background-worker/dist/main.js --once
```

## Configuration

All configuration is environment variables. The full table lives in
[reference/configuration.md](../reference/configuration.md); what follows is
what matters when you deploy.

## Production checklist

- `GATEWAY_BASE_URL` on HTTPS, on a domain you will not lose. Authorization
  servers will trust the client ID metadata document at that URL; see the
  residual risks in [threat-model.md](../architecture/threat-model.md).
- `GATEWAY_ENCRYPTION_KEYS` set explicitly. Without it a key is generated at
  boot and every stored credential becomes undecryptable on restart.
- `GATEWAY_SIGNING_KEY` set to a stable EC P-256 key, generated once with
  `openssl ecparam -genkey -name prime256v1 -noout | openssl pkcs8 -topk8 -nocrypt`.
  Without it a key is generated at boot, and after every restart authorization
  servers holding a cached JWKS reject the gateway's client assertions until
  that cache expires.
- `GATEWAY_DATABASE_URL` pointing at a Postgres, or `GATEWAY_DATABASE_FILE` at
  a path on durable storage. Neither set means an in-memory database, which
  serves every request correctly and loses every stored credential when the
  process exits. The gateway warns about this at startup; `uap-db check` is the
  way to confirm before it matters.
- `GATEWAY_ALLOWED_ORIGINS` set, so a page in a browser cannot drive the MCP
  endpoint.
- `GATEWAY_ALLOW_HTTP_UPSTREAMS`, `GATEWAY_ALLOW_LOOPBACK_UPSTREAMS` and
  `GATEWAY_ALLOW_PRIVATE_UPSTREAMS` all false unless a private upstream is a
  deliberate requirement, in which case pair them with an allowlist.
- Downstream authentication moved from shared API keys to the gateway's own
  OAuth resource, so each application has an attributable identity.

## The management page

`/ui` lists connections, adds them, toggles individual tools and shows the JSON
to paste into a client. `/` redirects to it.

Its real reason for existing is authorization. `/connect/:id` wants a bearer
header that no address bar will send, so the link cannot simply be opened; the
page asks `POST /api/v1/connections/{id}/authorize` with the key and follows the
answer, which is the same flow with the credential in the one place a browser
can put it. Authorizing an upstream is a click.

The page is served unauthenticated because it holds nothing: the key is typed
into the browser, kept in session storage for that tab, and sent as a header by
script. Nothing authenticates by cookie, so there is no request forgery to
defend against, and the document embeds no stored data at all — names and error
messages come from upstream servers, and reach the page through `textContent`
under a nonce-based content security policy that permits no other script.

`GATEWAY_UI_ENABLED=false` removes both routes for deployments that want no
HTML surface.

## The database

The gateway creates its own schema on boot, so nothing has to be run first.
Where that is the wrong moment to find out — a deploy that should fail before
the first instance starts, a connection string that should be checked before it
is trusted — `uap-db` does the same work without a gateway:

```bash
uap-db provision --url postgres://user:pass@host:5432/db --schema uap
uap-db check     # reads GATEWAY_DATABASE_URL, prints a row count per table
```

It resolves `GATEWAY_DATABASE_URL`, `GATEWAY_DATABASE_SCHEMA` and
`GATEWAY_DATABASE_FILE` exactly as the gateway does, so a database it prepared
is the one the gateway will open. `provision` is safe to rerun; `check` writes
nothing and exits non-zero when the schema is incomplete, which is enough to
gate a deploy.

Set `GATEWAY_DATABASE_SCHEMA` when the Postgres is a hosted product that
publishes a schema over HTTP. Supabase serves `public` through PostgREST, and
these tables hold credentials.

## Render

[render.yaml](../../render.yaml) describes a single web service. `HOST` already
defaults to `0.0.0.0` and the port is read from `PORT`, so nothing about the
bind address needs changing.

Free instances have no disk and an ephemeral filesystem, so a SQLite file goes
with the container on every deploy, restart, and the spin-down that follows
fifteen idle minutes — taking the OAuth grants with it and leaving every
upstream to be authorized again by hand. Set `GATEWAY_DATABASE_URL` to a
Postgres somewhere else and the problem goes away without a paid disk, because
the state is no longer on the instance at all.

Set `GATEWAY_DATABASE_SCHEMA` as well when that Postgres is a hosted product
that publishes a schema over HTTP. Supabase serves `public` through PostgREST,
and these tables hold credentials.

The background worker is the remaining gap: Render does not offer one on the
free plan. Nothing breaks, because the token manager refreshes an expired
token on the call that needs it, so a missing worker costs latency on the
first call after an expiry rather than correctness. What is lost is the
periodic work with no request to hang off — catalogue resync, session reaping
and key rewrap. Run `node apps/background-worker/dist/main.js --once` from a
cron job to get them back, or give it its own service, which is now possible:
a worker elsewhere shares Postgres with the API, and the two coordinate
through the lock table rather than a shared file.

## Endpoints

**Public.** `GET /ui`, `GET /` (redirects to it), `GET /healthz`, `GET /metrics`,
`GET /.well-known/oauth-protected-resource`,
`GET /oauth/client-metadata.json`, `GET /.well-known/jwks.json`.

**MCP.** `POST /mcp`, `GET /mcp`, `DELETE /mcp`.

**OAuth.** `GET /oauth/callback`, `GET /connect/:id`.

**Control plane**, all requiring a gateway credential:

```
POST   /api/v1/connections
GET    /api/v1/connections
GET    /api/v1/connections/:id
POST   /api/v1/connections/:id/authorize
POST   /api/v1/connections/:id/reconnect
POST   /api/v1/connections/:id/refresh
POST   /api/v1/connections/:id/alias
POST   /api/v1/connections/:id/enabled
DELETE /api/v1/connections/:id
GET    /api/v1/tools
POST   /api/v1/tools/:id
POST   /api/v1/oauth-client-configurations
GET    /api/v1/oauth-client-configurations
DELETE /api/v1/oauth-client-configurations/:id
POST   /api/v1/import
GET    /api/v1/audit
```

## Metrics

`/metrics` renders Prometheus text. Names come from
`packages/observability/src/metric-names.ts`.

OAuth: `oauth_authorization_started_total`,
`oauth_authorization_completed_total`, `oauth_authorization_failed_total`,
`oauth_token_refresh_total`, `oauth_token_refresh_failed_total`,
`oauth_reauth_required_total`, `oauth_dcr_total`, `oauth_cimd_total`,
`oauth_preregistered_total`.

MCP: `mcp_upstream_connection_total`,
`mcp_upstream_initialization_failed_total`, `mcp_tool_call_total`,
`mcp_tool_call_failed_total`, `mcp_tool_call_duration`,
`mcp_session_recreated_total`, `mcp_tool_schema_changed_total`.

Background: `background_job_run_total`, `background_job_failed_total`,
`background_job_duration`, `credential_rewrapped_total`,
`session_reaped_total`.

Security: `ssrf_request_blocked_total`, `invalid_issuer_total`,
`invalid_state_total`, `resource_mismatch_total`,
`tenant_access_denied_total`, `destructive_tool_confirmation_total`,
`token_decryption_failed_total`.

### What to alert on

| Signal | Why |
| --- | --- |
| `oauth_token_refresh_failed_total` rising | An authorization server is failing, or grants are being revoked en masse |
| `oauth_reauth_required_total` rising | Users are about to be interrupted; find out which issuer |
| `token_decryption_failed_total` above zero | A key ring problem. Nothing should ever fail to decrypt |
| `ssrf_request_blocked_total` rising | Either a misconfigured upstream or someone probing your network |
| `tenant_access_denied_total` above zero | Investigate; a correct client never triggers this |
| `background_job_failed_total` rising | Tokens are not being renewed ahead of use |
| `mcp_tool_call_failed_total` by alias | Isolates one unhealthy upstream from a systemic problem |

## Logs

Structured JSON. Every record carries the tenant, connection, upstream server,
issuer, operation, correlation ID, error class and timing where relevant. Every
record passes through the redaction pass; authorization codes, PKCE verifiers,
access and refresh tokens, client secrets and key material never reach the
sink.

## Runbooks

### A connection is stuck in REAUTH_REQUIRED

The grant is gone: the user revoked it, it expired, or a rotated refresh token
was replayed. There is no server-side repair. Send the user the
`connect_url` from `GET /api/v1/connections/:id`; one browser round trip
restores it. Every downstream client picks the connection back up without being
reconfigured.

### A connection is DEGRADED

The upstream or its authorization server failed transiently. The refresh token
is intact and the circuit breaker may be open. Check `last_error`, confirm the
provider is healthy, then force a pass:

```bash
curl -sX POST "$GATEWAY_URL/api/v1/connections/$ID/refresh" \
  -H "authorization: Bearer $GATEWAY_API_KEY"
```

### Tools disappeared from the catalogue

The upstream withdrew them, or its catalogue sync failed. `GET
/api/v1/connections/:id` shows `tool_count` and `last_error`. `POST
/api/v1/connections/:id/refresh` re-runs discovery immediately rather than
waiting for the worker.

If the tools are present upstream but hidden downstream, check policy: a tool
classified `DESTRUCTIVE` without a `destructiveHint` annotation is withheld by
default. `GET /api/v1/tools` shows every discovered tool with its risk level
and enabled flag, and `POST /api/v1/tools/:id` toggles one. A connection whose
status is `DISABLED` serves nothing at all; see below.

### An upstream is misbehaving and has to stop now

`POST /api/v1/connections/:id/enabled` with `{"enabled": false}` takes the
connection out of service: its tools, resources and prompts disappear from
every session, live upstream sessions are closed, and calls routed to it are
refused. The OAuth grant is kept, so `{"enabled": true}` puts it back and
re-runs discovery without sending the user through the provider's consent
screen again. Use `DELETE /api/v1/connections/:id` when the grant itself should
go.

### A tenant is being rate limited

Requests are metered per tenant with a token bucket that refills continuously,
so a burst is absorbed but a sustained flood is not. A throttled caller gets
HTTP 429 with `Retry-After`, or the JSON-RPC equivalent on the MCP endpoint,
and the message says how long to wait.

There are two budgets. `GATEWAY_API_REQUESTS_PER_MINUTE` covers the control
plane, opening an MCP session, and every MCP request except `ping`, which is
never throttled so that a client can always tell "slow down" apart from "gone".
`GATEWAY_TOOL_CALLS_PER_MINUTE` applies on top of that to `tools/call` alone,
because a tool call is the one request that spends an upstream's own quota.

Both limits are per gateway process. Raise them if the ceiling is genuinely
too low, but a tenant hitting one usually means a client is retrying in a
loop. Setting either to `0` disables that limit entirely.

### A user cannot call a tool they can see

Tools are listed according to what exists and called according to what the
user may do, so a read-only member sees a write tool in the catalogue and is
refused when calling it. That is deliberate: hiding it would make the refusal
look like a broken catalogue.

Roles come from `tenant_memberships`, seeded from the role field of
`GATEWAY_API_KEYS`. `GATEWAY_WRITE_ROLES` names the roles that may call
anything other than a read-only tool; leaving it unset allows every role.

### Rotating the encryption key

Add the new key at the front of `GATEWAY_ENCRYPTION_KEYS`, keeping the old one
so existing ciphertext stays readable:

```
GATEWAY_ENCRYPTION_KEYS="k2:<new base64>,k1:<old base64>"
```

Restart both processes. The worker's rewrap job moves stored credentials onto
`k2` over the following hour, or immediately with `--once`. Confirm
`credential_rewrapped_total` has stopped rising and that no ciphertext still
carries the old key ID before removing `k1` from the ring.

Rewrapping changes only the envelope. The plaintext and the token version are
untouched, so a refresh running at the same time still wins its
compare-and-swap.

### An authorization server outage

The circuit breaker opens after repeated failures and stops sending requests,
so the provider is not hammered while it recovers. Affected connections sit in
`DEGRADED` and keep their refresh tokens. `oauth_token_refresh_failed_total`
labelled by issuer identifies which one. No action is needed; the breaker
closes on its own.

### Restoring from backup

Restore the SQLite file together with the key ring that sealed it. Ciphertext
without its key is unrecoverable, and connections would all have to be
authorized again. Storing the key ring in a KMS separate from the database
backup is what makes a leaked backup insufficient on its own.
