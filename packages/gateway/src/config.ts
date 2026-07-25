import { GatewayError, isToolRiskLevel, parseScopes, type ToolRiskLevel } from "@umg/core";
import type { LogLevel } from "@umg/observability";

export interface ApiKeyPrincipal {
  /** Stored as the raw key for local development; hash in production. */
  key: string;
  tenantId: string;
  userId: string;
  label: string;
  /** Workspace role recorded for this principal; see `writeRoles`. */
  role: string;
}

export interface GatewayConfig {
  baseUrl: string;
  host: string;
  port: number;
  databaseFile: string;
  /** `kid:base64key[,kid:base64key]`; the first entry is the active key. */
  encryptionKeyRing: string | null;
  /**
   * PEM for the EC P-256 key that signs client assertions and DPoP proofs.
   * Unset generates one at boot, which is fine until a restart: authorization
   * servers cache the JWKS and reject assertions signed by the new key.
   */
  signingKeyPem: string | null;
  logLevel: LogLevel;
  allowedOrigins: string[];
  /**
   * Origins a post-authorization `return_to` may point at. The gateway's own
   * origin is always allowed; anything else has to be named here, or the
   * redirect becomes a phishing hop out of a legitimate consent screen.
   */
  returnToOrigins: string[];
  apiKeys: ApiKeyPrincipal[];
  /** Relaxations required for local development and the conformance suite. */
  allowHttp: boolean;
  allowLoopback: boolean;
  allowPrivateNetworks: boolean;
  hostAllowlist: string[];
  /** Authorization servers that issue tokens for the gateway itself. */
  gatewayAuthorizationServers: string[];
  gatewayScopesSupported: string[];
  /**
   * Scopes a downstream access token must carry at least one of. Defaults to
   * whatever the gateway advertises, so the metadata and the check agree.
   */
  gatewayRequiredScopes: string[];
  /** Claim naming the workspace an access token belongs to. */
  tenantClaim: string;
  /** Workspace used when a token carries no tenant claim. */
  defaultTenantId: string | null;
  /** Claim naming the caller's workspace roles. */
  rolesClaim: string;
  /** Role given to a token subject whose claims name none. */
  defaultRole: string;
  /** Roles allowed to call anything other than a read-only tool; empty allows all. */
  writeRoles: string[];
  /** Risk classes never exposed, whatever an upstream advertises. */
  blockedRiskLevels: ToolRiskLevel[];
  /** Risk classes that need a per-call human confirmation. */
  confirmationRiskLevels: ToolRiskLevel[];
  /** Expose tools that look destructive but carry no annotation saying so. */
  exposeUnreviewedDestructive: boolean;
  maxArgumentBytes: number;
  maxResultBytes: number;
  allowSampling: boolean;
  allowElicitation: boolean;
  /** Let upstreams read the client's roots, which name local directories. */
  allowRoots: boolean;
  /** Entries per page of `tools/list` and the other catalogue listings. */
  pageSize: number;
  /** Tool calls a tenant may make per minute; 0 disables the limit. */
  toolCallsPerMinute: number;
  /** Control-plane requests a tenant may make per minute; 0 disables the limit. */
  apiRequestsPerMinute: number;
  requestTimeoutMs: number;
  /** How long a pending upstream authorization stays valid. */
  authorizationTransactionTtlMs: number;
  logoUri: string | null;
  /** Advertised to downstream clients; omitted when the deployment has none. */
  documentationUri: string | null;
}

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8787",
  host: "0.0.0.0",
  port: 8787,
  databaseFile: ":memory:",
  logLevel: "info" as LogLevel,
  // Generous enough that an agent working hard never notices, low enough that
  // a runaway loop cannot exhaust an upstream's own quota.
  toolCallsPerMinute: 600,
  apiRequestsPerMinute: 300,
  requestTimeoutMs: 60_000,
  authorizationTransactionTtlMs: 600_000,
  confirmationRiskLevels: "DESTRUCTIVE,FINANCIAL",
  maxArgumentBytes: 256 * 1024,
  maxResultBytes: 4 * 1024 * 1024,
  pageSize: 100,
  tenantClaim: "tenant_id",
  rolesClaim: "roles",
  defaultRole: "member",
};

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseRiskLevels(name: string, value: string | undefined): ToolRiskLevel[] {
  return parseList(value).map((entry) => {
    const normalized = entry.toUpperCase();
    if (!isToolRiskLevel(normalized)) {
      throw new GatewayError("INVALID_REQUEST", `${name} lists an unknown risk level: ${entry}`);
    }
    return normalized;
  });
}

/** `key:tenant:user[:label[:role]]` entries separated by commas. */
export function parseApiKeys(value: string | undefined): ApiKeyPrincipal[] {
  return parseList(value).map((entry) => {
    const parts = entry.split(":");
    if (parts.length < 3) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "GATEWAY_API_KEYS entries must look like key:tenantId:userId[:label[:role]]",
      );
    }
    return {
      key: parts[0] ?? "",
      tenantId: parts[1] ?? "",
      userId: parts[2] ?? "",
      label: parts[3] ?? "gateway-client",
      role: parts[4] ?? "member",
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const baseUrl = (env["GATEWAY_BASE_URL"] ?? DEFAULTS.baseUrl).replace(/\/+$/u, "");
  const isLocal = baseUrl.startsWith("http://");
  const scopesSupported = parseScopes(env["GATEWAY_SCOPES_SUPPORTED"] ?? "mcp");
  return {
    baseUrl,
    host: env["HOST"] ?? DEFAULTS.host,
    port: Number(env["PORT"] ?? DEFAULTS.port),
    databaseFile: env["GATEWAY_DATABASE_FILE"] ?? DEFAULTS.databaseFile,
    encryptionKeyRing: env["GATEWAY_ENCRYPTION_KEYS"] ?? null,
    // Newlines survive an environment variable badly, so accept the escaped form.
    signingKeyPem: env["GATEWAY_SIGNING_KEY"]?.replaceAll("\\n", "\n") ?? null,
    logLevel: (env["LOG_LEVEL"] as LogLevel | undefined) ?? DEFAULTS.logLevel,
    allowedOrigins: parseList(env["GATEWAY_ALLOWED_ORIGINS"]),
    returnToOrigins: parseList(env["GATEWAY_RETURN_TO_ORIGINS"]),
    apiKeys: parseApiKeys(env["GATEWAY_API_KEYS"]),
    allowHttp: parseBool(env["GATEWAY_ALLOW_HTTP_UPSTREAMS"], isLocal),
    allowLoopback: parseBool(env["GATEWAY_ALLOW_LOOPBACK_UPSTREAMS"], isLocal),
    allowPrivateNetworks: parseBool(env["GATEWAY_ALLOW_PRIVATE_UPSTREAMS"], false),
    hostAllowlist: parseList(env["GATEWAY_UPSTREAM_HOST_ALLOWLIST"]),
    gatewayAuthorizationServers: parseList(env["GATEWAY_AUTHORIZATION_SERVERS"]),
    gatewayScopesSupported: scopesSupported,
    gatewayRequiredScopes: env["GATEWAY_REQUIRED_SCOPES"]
      ? parseScopes(env["GATEWAY_REQUIRED_SCOPES"])
      : scopesSupported,
    tenantClaim: env["GATEWAY_TENANT_CLAIM"] ?? DEFAULTS.tenantClaim,
    defaultTenantId: env["GATEWAY_DEFAULT_TENANT"] ?? null,
    rolesClaim: env["GATEWAY_ROLES_CLAIM"] ?? DEFAULTS.rolesClaim,
    defaultRole: env["GATEWAY_DEFAULT_ROLE"] ?? DEFAULTS.defaultRole,
    writeRoles: parseList(env["GATEWAY_WRITE_ROLES"]),
    blockedRiskLevels: parseRiskLevels(
      "GATEWAY_BLOCKED_RISK_LEVELS",
      env["GATEWAY_BLOCKED_RISK_LEVELS"],
    ),
    confirmationRiskLevels: parseRiskLevels(
      "GATEWAY_CONFIRMATION_RISK_LEVELS",
      env["GATEWAY_CONFIRMATION_RISK_LEVELS"] ?? DEFAULTS.confirmationRiskLevels,
    ),
    exposeUnreviewedDestructive: parseBool(
      env["GATEWAY_EXPOSE_UNREVIEWED_DESTRUCTIVE"],
      false,
    ),
    maxArgumentBytes: Number(
      env["GATEWAY_MAX_ARGUMENT_BYTES"] ?? DEFAULTS.maxArgumentBytes,
    ),
    maxResultBytes: Number(env["GATEWAY_MAX_RESULT_BYTES"] ?? DEFAULTS.maxResultBytes),
    allowSampling: parseBool(env["GATEWAY_ALLOW_SAMPLING"], true),
    allowElicitation: parseBool(env["GATEWAY_ALLOW_ELICITATION"], true),
    allowRoots: parseBool(env["GATEWAY_ALLOW_ROOTS"], true),
    pageSize: Number(env["GATEWAY_PAGE_SIZE"] ?? DEFAULTS.pageSize),
    toolCallsPerMinute: Number(
      env["GATEWAY_TOOL_CALLS_PER_MINUTE"] ?? DEFAULTS.toolCallsPerMinute,
    ),
    apiRequestsPerMinute: Number(
      env["GATEWAY_API_REQUESTS_PER_MINUTE"] ?? DEFAULTS.apiRequestsPerMinute,
    ),
    requestTimeoutMs: Number(env["GATEWAY_REQUEST_TIMEOUT_MS"] ?? DEFAULTS.requestTimeoutMs),
    authorizationTransactionTtlMs: Number(
      env["GATEWAY_AUTHORIZATION_TTL_MS"] ?? DEFAULTS.authorizationTransactionTtlMs,
    ),
    logoUri: env["GATEWAY_LOGO_URI"] ?? null,
    documentationUri: env["GATEWAY_DOCUMENTATION_URI"] ?? null,
  };
}
