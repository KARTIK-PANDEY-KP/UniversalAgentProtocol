# Configuration reference

Every setting the gateway has, in one table. For what to set them to when
you deploy, see the production checklist in
[operations/running.md](../operations/running.md).


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
| `GATEWAY_BLOCKED_RISK_LEVELS` | none | Risk classes never exposed, whatever an upstream advertises |
| `GATEWAY_CONFIRMATION_RISK_LEVELS` | `DESTRUCTIVE,FINANCIAL` | Risk classes that need a per-call confirmation |
| `GATEWAY_EXPOSE_UNREVIEWED_DESTRUCTIVE` | `false` | Expose tools that look destructive but carry no annotation saying so |
| `GATEWAY_MAX_ARGUMENT_BYTES` | `262144` | Largest tool argument payload accepted |
| `GATEWAY_MAX_RESULT_BYTES` | `4194304` | Largest upstream tool result accepted |
| `GATEWAY_ALLOW_SAMPLING` | `true` | Permit upstreams to ask the client for a model completion |
| `GATEWAY_ALLOW_ELICITATION` | `true` | Permit upstreams to ask the client for input |
| `GATEWAY_PAGE_SIZE` | `100` | Entries per page of `tools/list`, `resources/list` and `prompts/list` |
| `GATEWAY_TOOL_CALLS_PER_MINUTE` | `600` | Tool calls a tenant may make per minute; `0` disables the limit |
| `GATEWAY_API_REQUESTS_PER_MINUTE` | `300` | Control-plane and MCP requests a tenant may make per minute; `0` disables the limit |
| `GATEWAY_ALLOWED_ORIGINS` | none | Origins permitted on the MCP endpoint |
| `GATEWAY_RETURN_TO_ORIGINS` | none | Extra origins a post-authorization `return_to` may point at; the gateway's own origin is always allowed |
| `GATEWAY_AUTHORIZATION_SERVERS` | none | Issuers whose access tokens the gateway accepts in place of an API key; unset disables token authentication |
| `GATEWAY_SCOPES_SUPPORTED` | `mcp` | Scopes advertised in the gateway's protected resource metadata |
| `GATEWAY_REQUIRED_SCOPES` | the advertised scopes | Scopes an access token must carry at least one of |
| `GATEWAY_TENANT_CLAIM` | `tenant_id` | Claim naming the workspace an access token belongs to |
| `GATEWAY_DEFAULT_TENANT` | none | Workspace used when a token carries no tenant claim; without it such a token is refused |
| `GATEWAY_ROLES_CLAIM` | `roles` | Claim naming the caller's workspace roles |
| `GATEWAY_DEFAULT_ROLE` | `member` | Role given to a subject whose claims name none |
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
