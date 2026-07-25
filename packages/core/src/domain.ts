import type { JsonObject } from "./json-rpc.js";
import type { TokenEndpointAuthMethod } from "./oauth.js";

export type ConnectionOwnerType = "USER" | "WORKSPACE";

export type ConnectionStatus =
  | "PENDING"
  | "AUTHORIZATION_REQUIRED"
  | "CLIENT_CREDENTIALS_REQUIRED"
  | "CONNECTED"
  | "CONNECTED_NON_REFRESHABLE"
  | "REAUTH_REQUIRED"
  | "DEGRADED"
  | "DISABLED";

export type RegistrationType =
  | "CIMD"
  | "DYNAMIC"
  | "PRECONFIGURED"
  | "USER_SUPPLIED";

export type TransportType = "STREAMABLE_HTTP" | "HTTP_SSE" | "UNKNOWN";

/**
 * Coarse capability classes used by the policy engine. Classification is
 * derived from generic MCP tool annotations and heuristics, never from
 * knowledge of a specific provider.
 */
export const TOOL_RISK_LEVELS = [
  "READ_ONLY",
  "WRITE",
  "DESTRUCTIVE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL",
  "ADMINISTRATIVE",
  "UNKNOWN",
] as const;

export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export function isToolRiskLevel(value: string): value is ToolRiskLevel {
  return (TOOL_RISK_LEVELS as readonly string[]).includes(value);
}

export interface Tenant {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: number;
}

export interface User {
  id: string;
  tenantId: string;
  externalIdentity: string;
  email: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: number;
}

/**
 * A user's role within a tenant. Roles gate which tools they may call; see
 * `ToolPolicy.writeRoles`.
 */
export interface TenantMembership {
  tenantId: string;
  userId: string;
  role: string;
  createdAt: number;
}

/**
 * The private half of a DPoP key pair. One per connection, so a stolen token
 * for one upstream cannot be replayed against another.
 */
export interface DpopKeyRecord {
  id: string;
  tenantId: string;
  privateKeyEncrypted: string;
  publicJwkJson: JsonObject;
  createdAt: number;
}

export interface McpServerRecord {
  id: string;
  tenantId: string;
  canonicalUrl: string;
  originalUrl: string;
  displayName: string;
  authorizationRequired: boolean;
  protectedResourceMetadataUrl: string | null;
  canonicalResource: string | null;
  selectedAuthorizationServer: string | null;
  transportType: TransportType;
  protocolVersion: string | null;
  capabilitiesJson: JsonObject | null;
  metadataJson: JsonObject | null;
  status: "ACTIVE" | "UNREACHABLE" | "NOT_MCP";
  createdAt: number;
  updatedAt: number;
}

export interface OAuthIssuerRecord {
  id: string;
  issuer: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  metadataJson: JsonObject;
  metadataEtag: string | null;
  metadataExpiresAt: number;
  supportsCimd: boolean;
  supportsDcr: boolean;
  supportedAuthMethods: string[];
  status: "ACTIVE" | "UNREACHABLE";
}

export interface OAuthClientRegistrationRecord {
  id: string;
  tenantId: string;
  issuerId: string;
  registrationType: RegistrationType;
  clientId: string;
  encryptedClientSecret: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: string[];
  registrationAccessTokenEncrypted: string | null;
  registrationClientUri: string | null;
  issuedAt: number;
  secretExpiresAt: number | null;
  metadataJson: JsonObject;
  status: "ACTIVE" | "INVALID";
}

export interface UpstreamConnection {
  id: string;
  tenantId: string;
  ownerType: ConnectionOwnerType;
  ownerId: string;
  mcpServerId: string;
  oauthIssuerId: string | null;
  oauthClientRegistrationId: string | null;
  alias: string;
  grantedScopes: string[];
  /**
   * Scopes to ask for on the next authorization. Starts as what the upstream
   * advertised and grows when a tool call fails with `insufficient_scope`, so
   * reconnecting widens the grant instead of repeating the same narrow request.
   */
  requestedScopes: string[];
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  /**
   * Generic static headers for MCP servers that authenticate with a long-lived
   * secret instead of OAuth. Values are stored encrypted as a single blob.
   */
  staticHeadersEncrypted: string | null;
  tokenType: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  tokenVersion: number;
  dpopKeyReference: string | null;
  status: ConnectionStatus;
  lastRefreshAt: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessageRedacted: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OAuthTransaction {
  id: string;
  tenantId: string;
  userId: string;
  connectionId: string;
  issuer: string;
  stateHash: string;
  pkceVerifierEncrypted: string;
  redirectUri: string;
  requestedScopes: string[];
  resource: string | null;
  expiresAt: number;
  consumedAt: number | null;
  status: "PENDING" | "CONSUMED" | "EXPIRED" | "FAILED";
  returnTo: string | null;
}

export interface DiscoveredTool {
  id: string;
  tenantId: string;
  connectionId: string;
  upstreamName: string;
  gatewayName: string;
  description: string | null;
  inputSchemaJson: JsonObject;
  outputSchemaJson: JsonObject | null;
  annotationsJson: JsonObject | null;
  schemaHash: string;
  enabled: boolean;
  riskLevel: ToolRiskLevel;
  discoveredAt: number;
  lastSeenAt: number;
}

export interface DiscoveredResource {
  id: string;
  tenantId: string;
  connectionId: string;
  upstreamUri: string;
  gatewayUri: string;
  name: string;
  description: string | null;
  mimeType: string | null;
  isTemplate: boolean;
  lastSeenAt: number;
}

export interface DiscoveredPrompt {
  id: string;
  tenantId: string;
  connectionId: string;
  upstreamName: string;
  gatewayName: string;
  description: string | null;
  argumentsJson: JsonObject | null;
  lastSeenAt: number;
}

export interface DownstreamSession {
  id: string;
  tenantId: string;
  userId: string;
  clientLabel: string;
  protocolVersion: string;
  capabilitiesJson: JsonObject;
  createdAt: number;
  lastSeenAt: number;
  status: "ACTIVE" | "CLOSED";
}

export interface UpstreamSessionRecord {
  id: string;
  tenantId: string;
  connectionId: string;
  downstreamSessionId: string;
  /**
   * The upstream's own session id is deliberately not recorded. It is a live
   * session handle, it lives with the client object that owns it, and nothing
   * could resume it later: the downstream session it belongs to is in-process
   * too, so it dies with the same restart. Keeping a copy at rest would be a
   * credential nothing reads.
   */
  protocolVersion: string;
  capabilitiesJson: JsonObject;
  status: "ACTIVE" | "CLOSED";
  createdAt: number;
  lastSeenAt: number;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  userId: string | null;
  downstreamSessionId: string | null;
  connectionId: string | null;
  toolId: string | null;
  operation: string;
  inputHash: string | null;
  resultStatus: "OK" | "ERROR" | "DENIED";
  durationMs: number | null;
  providerRequestId: string | null;
  detailJson: JsonObject | null;
  createdAt: number;
}

export interface PreconfiguredOAuthClient {
  id: string;
  tenantId: string;
  issuer: string;
  /** Empty when the operator supplied only a registration token. */
  clientId: string;
  clientSecretEncrypted: string | null;
  /**
   * RFC 7591 initial access token for an authorization server whose
   * registration endpoint is closed to anonymous clients.
   */
  initialAccessTokenEncrypted: string | null;
  redirectUri: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  scopes: string[] | null;
  createdAt: number;
}
