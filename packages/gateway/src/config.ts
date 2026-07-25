import { GatewayError, parseScopes } from "@umg/core";
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
  logLevel: LogLevel;
  allowedOrigins: string[];
  apiKeys: ApiKeyPrincipal[];
  /** Relaxations required for local development and the conformance suite. */
  allowHttp: boolean;
  allowLoopback: boolean;
  allowPrivateNetworks: boolean;
  hostAllowlist: string[];
  /** Authorization servers that issue tokens for the gateway itself. */
  gatewayAuthorizationServers: string[];
  gatewayScopesSupported: string[];
  /** Roles allowed to call anything other than a read-only tool; empty allows all. */
  writeRoles: string[];
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
  requestTimeoutMs: 60_000,
  authorizationTransactionTtlMs: 600_000,
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
  return {
    baseUrl,
    host: env["HOST"] ?? DEFAULTS.host,
    port: Number(env["PORT"] ?? DEFAULTS.port),
    databaseFile: env["GATEWAY_DATABASE_FILE"] ?? DEFAULTS.databaseFile,
    encryptionKeyRing: env["GATEWAY_ENCRYPTION_KEYS"] ?? null,
    logLevel: (env["LOG_LEVEL"] as LogLevel | undefined) ?? DEFAULTS.logLevel,
    allowedOrigins: parseList(env["GATEWAY_ALLOWED_ORIGINS"]),
    apiKeys: parseApiKeys(env["GATEWAY_API_KEYS"]),
    allowHttp: parseBool(env["GATEWAY_ALLOW_HTTP_UPSTREAMS"], isLocal),
    allowLoopback: parseBool(env["GATEWAY_ALLOW_LOOPBACK_UPSTREAMS"], isLocal),
    allowPrivateNetworks: parseBool(env["GATEWAY_ALLOW_PRIVATE_UPSTREAMS"], false),
    hostAllowlist: parseList(env["GATEWAY_UPSTREAM_HOST_ALLOWLIST"]),
    gatewayAuthorizationServers: parseList(env["GATEWAY_AUTHORIZATION_SERVERS"]),
    gatewayScopesSupported: parseScopes(env["GATEWAY_SCOPES_SUPPORTED"] ?? "mcp"),
    writeRoles: parseList(env["GATEWAY_WRITE_ROLES"]),
    requestTimeoutMs: Number(env["GATEWAY_REQUEST_TIMEOUT_MS"] ?? DEFAULTS.requestTimeoutMs),
    authorizationTransactionTtlMs: Number(
      env["GATEWAY_AUTHORIZATION_TTL_MS"] ?? DEFAULTS.authorizationTransactionTtlMs,
    ),
    logoUri: env["GATEWAY_LOGO_URI"] ?? null,
    documentationUri: env["GATEWAY_DOCUMENTATION_URI"] ?? null,
  };
}
