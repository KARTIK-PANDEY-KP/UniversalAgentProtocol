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

All configuration is environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_BASE_URL` | `http://127.0.0.1:8787` | Public origin; determines the OAuth redirect URI and the client ID metadata document URL |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8787` | Bind port |
| `GATEWAY_DATABASE_FILE` | `:memory:` | SQLite path; set this or nothing survives a restart |
| `GATEWAY_ENCRYPTION_KEYS` | generated | `kid:base64key[,kid:base64key]`, first entry active |
| `GATEWAY_API_KEYS` | none | `key:tenantId:userId[:label[:role]]` entries, comma separated; the role defaults to `member` |
| `GATEWAY_WRITE_ROLES` | none | Roles allowed to call anything other than a read-only tool; unset allows every role |
| `GATEWAY_TOOL_CALLS_PER_MINUTE` | `600` | Tool calls a tenant may make per minute; `0` disables the limit |
| `GATEWAY_API_REQUESTS_PER_MINUTE` | `300` | Control-plane requests a tenant may make per minute; `0` disables the limit |
| `GATEWAY_ALLOWED_ORIGINS` | none | Origins permitted on the MCP endpoint |
| `GATEWAY_AUTHORIZATION_SERVERS` | none | Issuers that mint tokens for the gateway itself |
| `GATEWAY_SCOPES_SUPPORTED` | `mcp` | Scopes advertised in the gateway's protected resource metadata |
| `GATEWAY_ALLOW_HTTP_UPSTREAMS` | true when the base URL is HTTP | Permit `http://` upstreams |
| `GATEWAY_ALLOW_LOOPBACK_UPSTREAMS` | true when the base URL is HTTP | Permit loopback upstreams |
| `GATEWAY_ALLOW_PRIVATE_UPSTREAMS` | `false` | Permit RFC 1918 and similar ranges |
| `GATEWAY_UPSTREAM_HOST_ALLOWLIST` | none | When set, the only hosts that may be contacted |
| `GATEWAY_REQUEST_TIMEOUT_MS` | `60000` | Upstream request timeout |
| `GATEWAY_AUTHORIZATION_TTL_MS` | `600000` | How long a pending authorization stays valid |
| `GATEWAY_LOGO_URI` | none | Logo advertised in the client ID metadata document |
| `GATEWAY_DOCUMENTATION_URI` | none | Documentation link advertised in the gateway's protected resource metadata |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

Worker intervals, all milliseconds:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKER_REFRESH_HORIZON_MS` | 5 min | Renew a token this long before it expires |
| `WORKER_REFRESH_INTERVAL_MS` | 1 min | How often to look for tokens to renew |
| `WORKER_CATALOGUE_INTERVAL_MS` | 15 min | Maximum age of a discovered catalogue |
| `WORKER_SESSION_IDLE_MS` | 30 min | Idle window before a session is closed |
| `WORKER_REAP_INTERVAL_MS` | 5 min | How often to reap sessions and transactions |
| `WORKER_REWRAP_INTERVAL_MS` | 60 min | How often to look for credentials on a retired key |
| `WORKER_BATCH_SIZE` | 100 | Connections processed per pass |

### Production checklist

- `GATEWAY_BASE_URL` on HTTPS, on a domain you will not lose. Authorization
  servers will trust the client ID metadata document at that URL; see the
  residual risks in [threat-model.md](threat-model.md).
- `GATEWAY_ENCRYPTION_KEYS` set explicitly. Without it a key is generated at
  boot and every stored credential becomes undecryptable on restart.
- `GATEWAY_DATABASE_FILE` on durable storage, not an ephemeral container
  filesystem.
- `GATEWAY_ALLOWED_ORIGINS` set, so a page in a browser cannot drive the MCP
  endpoint.
- `GATEWAY_ALLOW_HTTP_UPSTREAMS`, `GATEWAY_ALLOW_LOOPBACK_UPSTREAMS` and
  `GATEWAY_ALLOW_PRIVATE_UPSTREAMS` all false unless a private upstream is a
  deliberate requirement, in which case pair them with an allowlist.
- Downstream authentication moved from shared API keys to the gateway's own
  OAuth resource, so each application has an attributable identity.

## Endpoints

**Public.** `GET /healthz`, `GET /metrics`,
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
DELETE /api/v1/connections/:id
GET    /api/v1/tools
POST   /api/v1/tools/:id
POST   /api/v1/oauth-client-configurations
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
and enabled flag, and `POST /api/v1/tools/:id` toggles one.

### A tenant is being rate limited

Tool calls and control-plane requests are metered per tenant with a token
bucket that refills continuously, so a burst is absorbed but a sustained flood
is not. A throttled caller gets HTTP 429 with `Retry-After`, or the JSON-RPC
equivalent on the MCP endpoint, and the message says how long to wait.

Both limits are per gateway process. Raise `GATEWAY_TOOL_CALLS_PER_MINUTE` or
`GATEWAY_API_REQUESTS_PER_MINUTE` if the ceiling is genuinely too low, but a
tenant hitting it usually means a client is retrying in a loop. Setting either
to `0` disables that limit entirely.

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
