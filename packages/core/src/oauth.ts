/**
 * Wire types for the OAuth documents the gateway discovers at runtime. Every
 * field is optional beyond what the relevant RFC mandates, because the gateway
 * must tolerate authorization servers that publish partial metadata.
 */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  jwks_uri?: string;
  pushed_authorization_request_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_signing_alg_values_supported?: string[];
  /** RFC 9449 */
  dpop_signing_alg_values_supported?: string[];
  /** OAuth Client ID Metadata Documents */
  client_id_metadata_document_supported?: boolean;
  require_pushed_authorization_requests?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
  [key: string]: unknown;
}

/** RFC 9728 protected resource metadata. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  resource_name?: string;
  dpop_bound_access_tokens_required?: boolean;
  dpop_signing_alg_values_supported?: string[];
  [key: string]: unknown;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  id_token?: string;
  [key: string]: unknown;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
  [key: string]: unknown;
}

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
  token_endpoint_auth_method?: string;
  [key: string]: unknown;
}

export type TokenEndpointAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

export const TOKEN_ENDPOINT_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
];

export function isTokenEndpointAuthMethod(
  value: string,
): value is TokenEndpointAuthMethod {
  return (TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value);
}

/** A parsed `WWW-Authenticate` challenge. */
export interface WwwAuthenticateChallenge {
  scheme: string;
  params: Record<string, string>;
}

export interface ClientIdMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  jwks_uri?: string;
  scope?: string;
  software_id?: string;
  software_version?: string;
  [key: string]: unknown;
}
