import type {
  AuditEvent,
  DiscoveredPrompt,
  DiscoveredResource,
  DiscoveredTool,
  DownstreamSession,
  DpopKeyRecord,
  McpServerRecord,
  OAuthClientRegistrationRecord,
  OAuthIssuerRecord,
  OAuthTransaction,
  PreconfiguredOAuthClient,
  Tenant,
  TenantMembership,
  UpstreamConnection,
  UpstreamSessionRecord,
  User,
} from "@uap/core";

import { bool, json, jsonArray, num, text, textNull, type Mapper } from "./mapper.js";

export const DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_identity TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  original_url TEXT NOT NULL,
  display_name TEXT NOT NULL,
  authorization_required INTEGER NOT NULL,
  protected_resource_metadata_url TEXT,
  canonical_resource TEXT,
  selected_authorization_server TEXT,
  transport_type TEXT NOT NULL,
  protocol_version TEXT,
  capabilities_json TEXT,
  metadata_json TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, canonical_url)
);

CREATE TABLE IF NOT EXISTS oauth_issuers (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL UNIQUE,
  authorization_endpoint TEXT,
  token_endpoint TEXT,
  registration_endpoint TEXT,
  revocation_endpoint TEXT,
  metadata_json TEXT NOT NULL,
  metadata_etag TEXT,
  metadata_expires_at INTEGER NOT NULL,
  supports_cimd INTEGER NOT NULL,
  supports_dcr INTEGER NOT NULL,
  supported_auth_methods TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_client_registrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  issuer_id TEXT NOT NULL REFERENCES oauth_issuers(id),
  registration_type TEXT NOT NULL,
  client_id TEXT NOT NULL,
  encrypted_client_secret TEXT,
  token_endpoint_auth_method TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  registration_access_token_encrypted TEXT,
  registration_client_uri TEXT,
  issued_at INTEGER NOT NULL,
  secret_expires_at INTEGER,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registrations_tenant_issuer
  ON oauth_client_registrations (tenant_id, issuer_id, status);

CREATE TABLE IF NOT EXISTS upstream_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  oauth_issuer_id TEXT,
  oauth_client_registration_id TEXT,
  alias TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  requested_scopes TEXT NOT NULL DEFAULT '[]',
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  static_headers_encrypted TEXT,
  token_type TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  token_version INTEGER NOT NULL,
  dpop_key_reference TEXT,
  status TEXT NOT NULL,
  last_refresh_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_error_message_redacted TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, alias)
);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  pkce_verifier_encrypted TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  requested_scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL,
  return_to TEXT
);

CREATE TABLE IF NOT EXISTS discovered_tools (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES upstream_connections(id) ON DELETE CASCADE,
  upstream_name TEXT NOT NULL,
  gateway_name TEXT NOT NULL,
  description TEXT,
  input_schema_json TEXT NOT NULL,
  output_schema_json TEXT,
  annotations_json TEXT,
  schema_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (connection_id, upstream_name)
);
CREATE INDEX IF NOT EXISTS idx_tools_tenant ON discovered_tools (tenant_id, gateway_name);

CREATE TABLE IF NOT EXISTS discovered_resources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES upstream_connections(id) ON DELETE CASCADE,
  upstream_uri TEXT NOT NULL,
  gateway_uri TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  mime_type TEXT,
  is_template INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (connection_id, upstream_uri)
);

CREATE TABLE IF NOT EXISTS discovered_prompts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES upstream_connections(id) ON DELETE CASCADE,
  upstream_name TEXT NOT NULL,
  gateway_name TEXT NOT NULL,
  description TEXT,
  arguments_json TEXT,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (connection_id, upstream_name)
);

CREATE TABLE IF NOT EXISTS downstream_mcp_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_label TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upstream_mcp_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  downstream_session_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (connection_id, downstream_session_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  downstream_session_id TEXT,
  connection_id TEXT,
  tool_id TEXT,
  operation TEXT NOT NULL,
  input_hash TEXT,
  result_status TEXT NOT NULL,
  duration_ms INTEGER,
  provider_request_id TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS preconfigured_oauth_clients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT,
  initial_access_token_encrypted TEXT,
  redirect_uri TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  scopes TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, issuer)
);

CREATE TABLE IF NOT EXISTS dpop_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS distributed_locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export const tenantMapper: Mapper<Tenant> = {
  id: text("id"),
  name: text("name"),
  status: text("status"),
  createdAt: num("created_at"),
};

export const userMapper: Mapper<User> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  externalIdentity: text("external_identity"),
  email: text("email"),
  status: text("status"),
  createdAt: num("created_at"),
};

export const membershipMapper: Mapper<TenantMembership> = {
  tenantId: text("tenant_id"),
  userId: text("user_id"),
  role: text("role"),
  createdAt: num("created_at"),
};

export const dpopKeyMapper: Mapper<DpopKeyRecord> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  privateKeyEncrypted: text("private_key_encrypted"),
  publicJwkJson: json("public_jwk_json"),
  createdAt: num("created_at"),
};

export const mcpServerMapper: Mapper<McpServerRecord> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  canonicalUrl: text("canonical_url"),
  originalUrl: text("original_url"),
  displayName: text("display_name"),
  authorizationRequired: bool("authorization_required"),
  protectedResourceMetadataUrl: textNull("protected_resource_metadata_url"),
  canonicalResource: textNull("canonical_resource"),
  selectedAuthorizationServer: textNull("selected_authorization_server"),
  transportType: text("transport_type"),
  protocolVersion: textNull("protocol_version"),
  capabilitiesJson: json("capabilities_json"),
  metadataJson: json("metadata_json"),
  status: text("status"),
  createdAt: num("created_at"),
  updatedAt: num("updated_at"),
};

export const issuerMapper: Mapper<OAuthIssuerRecord> = {
  id: text("id"),
  issuer: text("issuer"),
  authorizationEndpoint: textNull("authorization_endpoint"),
  tokenEndpoint: textNull("token_endpoint"),
  registrationEndpoint: textNull("registration_endpoint"),
  revocationEndpoint: textNull("revocation_endpoint"),
  metadataJson: json("metadata_json"),
  metadataEtag: textNull("metadata_etag"),
  metadataExpiresAt: num("metadata_expires_at"),
  supportsCimd: bool("supports_cimd"),
  supportsDcr: bool("supports_dcr"),
  supportedAuthMethods: jsonArray("supported_auth_methods"),
  status: text("status"),
};

export const registrationMapper: Mapper<OAuthClientRegistrationRecord> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  issuerId: text("issuer_id"),
  registrationType: text("registration_type"),
  clientId: text("client_id"),
  encryptedClientSecret: textNull("encrypted_client_secret"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  redirectUris: jsonArray("redirect_uris"),
  registrationAccessTokenEncrypted: textNull("registration_access_token_encrypted"),
  registrationClientUri: textNull("registration_client_uri"),
  issuedAt: num("issued_at"),
  secretExpiresAt: num("secret_expires_at"),
  metadataJson: json("metadata_json"),
  status: text("status"),
};

export const connectionMapper: Mapper<UpstreamConnection> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  ownerType: text("owner_type"),
  ownerId: text("owner_id"),
  mcpServerId: text("mcp_server_id"),
  oauthIssuerId: textNull("oauth_issuer_id"),
  oauthClientRegistrationId: textNull("oauth_client_registration_id"),
  alias: text("alias"),
  grantedScopes: jsonArray("granted_scopes"),
  requestedScopes: jsonArray("requested_scopes"),
  accessTokenEncrypted: textNull("access_token_encrypted"),
  refreshTokenEncrypted: textNull("refresh_token_encrypted"),
  staticHeadersEncrypted: textNull("static_headers_encrypted"),
  tokenType: textNull("token_type"),
  accessTokenExpiresAt: num("access_token_expires_at"),
  refreshTokenExpiresAt: num("refresh_token_expires_at"),
  tokenVersion: num("token_version"),
  dpopKeyReference: textNull("dpop_key_reference"),
  status: text("status"),
  lastRefreshAt: num("last_refresh_at"),
  lastSuccessAt: num("last_success_at"),
  lastErrorCode: textNull("last_error_code"),
  lastErrorMessageRedacted: textNull("last_error_message_redacted"),
  createdAt: num("created_at"),
  updatedAt: num("updated_at"),
};

export const transactionMapper: Mapper<OAuthTransaction> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  userId: text("user_id"),
  connectionId: text("connection_id"),
  issuer: text("issuer"),
  stateHash: text("state_hash"),
  pkceVerifierEncrypted: text("pkce_verifier_encrypted"),
  redirectUri: text("redirect_uri"),
  requestedScopes: jsonArray("requested_scopes"),
  resource: textNull("resource"),
  expiresAt: num("expires_at"),
  consumedAt: num("consumed_at"),
  status: text("status"),
  returnTo: textNull("return_to"),
};

export const toolMapper: Mapper<DiscoveredTool> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  connectionId: text("connection_id"),
  upstreamName: text("upstream_name"),
  gatewayName: text("gateway_name"),
  description: textNull("description"),
  inputSchemaJson: json("input_schema_json"),
  outputSchemaJson: json("output_schema_json"),
  annotationsJson: json("annotations_json"),
  schemaHash: text("schema_hash"),
  enabled: bool("enabled"),
  riskLevel: text("risk_level"),
  discoveredAt: num("discovered_at"),
  lastSeenAt: num("last_seen_at"),
};

export const resourceMapper: Mapper<DiscoveredResource> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  connectionId: text("connection_id"),
  upstreamUri: text("upstream_uri"),
  gatewayUri: text("gateway_uri"),
  name: text("name"),
  description: textNull("description"),
  mimeType: textNull("mime_type"),
  isTemplate: bool("is_template"),
  lastSeenAt: num("last_seen_at"),
};

export const promptMapper: Mapper<DiscoveredPrompt> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  connectionId: text("connection_id"),
  upstreamName: text("upstream_name"),
  gatewayName: text("gateway_name"),
  description: textNull("description"),
  argumentsJson: json("arguments_json"),
  lastSeenAt: num("last_seen_at"),
};

export const downstreamSessionMapper: Mapper<DownstreamSession> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  userId: text("user_id"),
  clientLabel: text("client_label"),
  protocolVersion: text("protocol_version"),
  capabilitiesJson: json("capabilities_json"),
  createdAt: num("created_at"),
  lastSeenAt: num("last_seen_at"),
  status: text("status"),
};

export const upstreamSessionMapper: Mapper<UpstreamSessionRecord> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  connectionId: text("connection_id"),
  downstreamSessionId: text("downstream_session_id"),
  protocolVersion: text("protocol_version"),
  capabilitiesJson: json("capabilities_json"),
  status: text("status"),
  createdAt: num("created_at"),
  lastSeenAt: num("last_seen_at"),
};

export const auditMapper: Mapper<AuditEvent> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  userId: textNull("user_id"),
  downstreamSessionId: textNull("downstream_session_id"),
  connectionId: textNull("connection_id"),
  toolId: textNull("tool_id"),
  operation: text("operation"),
  inputHash: textNull("input_hash"),
  resultStatus: text("result_status"),
  durationMs: num("duration_ms"),
  providerRequestId: textNull("provider_request_id"),
  detailJson: json("detail_json"),
  createdAt: num("created_at"),
};

export const preconfiguredClientMapper: Mapper<PreconfiguredOAuthClient> = {
  id: text("id"),
  tenantId: text("tenant_id"),
  issuer: text("issuer"),
  clientId: text("client_id"),
  clientSecretEncrypted: textNull("client_secret_encrypted"),
  initialAccessTokenEncrypted: textNull("initial_access_token_encrypted"),
  redirectUri: text("redirect_uri"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  scopes: json("scopes"),
  createdAt: num("created_at"),
};
