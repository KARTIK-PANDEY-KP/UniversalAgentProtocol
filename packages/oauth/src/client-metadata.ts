import { GatewayError, type ClientIdMetadataDocument } from "@umg/core";
import { parseAbsoluteUrl } from "@umg/security";

export interface GatewayIdentity {
  /** Public origin of this gateway deployment, for example `https://gateway.example.com`. */
  baseUrl: string;
  clientName: string;
  clientMetadataUrl: string;
  redirectUri: string;
  jwksUri: string;
  logoUri?: string;
  softwareId: string;
  softwareVersion: string;
  /** Set to false when the deployment has no signing keys published. */
  supportsPrivateKeyJwt: boolean;
}

export function gatewayIdentityFromBaseUrl(
  baseUrl: string,
  overrides: Partial<GatewayIdentity> = {},
): GatewayIdentity {
  const origin = baseUrl.replace(/\/+$/u, "");
  return {
    baseUrl: origin,
    clientName: "Universal MCP Gateway",
    clientMetadataUrl: `${origin}/oauth/client-metadata.json`,
    redirectUri: `${origin}/oauth/callback`,
    jwksUri: `${origin}/.well-known/jwks.json`,
    softwareId: "universal-mcp-gateway",
    softwareVersion: "0.1.0",
    supportsPrivateKeyJwt: true,
    ...overrides,
  };
}

/**
 * The document the gateway publishes so that authorization servers supporting
 * Client ID Metadata Documents can identify it by URL. The `client_id` is the
 * document URL itself and must match byte for byte.
 */
export function buildClientIdMetadataDocument(
  identity: GatewayIdentity,
): ClientIdMetadataDocument {
  const document: ClientIdMetadataDocument = {
    client_id: identity.clientMetadataUrl,
    client_name: identity.clientName,
    client_uri: identity.baseUrl,
    redirect_uris: [identity.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: identity.supportsPrivateKeyJwt
      ? "private_key_jwt"
      : "none",
    software_id: identity.softwareId,
    software_version: identity.softwareVersion,
  };
  if (identity.supportsPrivateKeyJwt) document["jwks_uri"] = identity.jwksUri;
  if (identity.logoUri) document["logo_uri"] = identity.logoUri;
  return document;
}

/**
 * Enforces the invariants the MCP specification places on a metadata document
 * URL: HTTPS, a non-empty path, and an exact match with the `client_id`.
 */
export function assertValidClientIdMetadataUrl(
  clientMetadataUrl: string,
  document: ClientIdMetadataDocument,
  options: { allowHttp?: boolean } = {},
): void {
  const url = parseAbsoluteUrl(clientMetadataUrl);
  if (url.protocol !== "https:" && options.allowHttp !== true) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "A client ID metadata document URL must use HTTPS",
    );
  }
  if (url.pathname === "" || url.pathname === "/") {
    throw new GatewayError(
      "INVALID_REQUEST",
      "A client ID metadata document URL must contain a path",
    );
  }
  if (document.client_id !== clientMetadataUrl) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "The client_id inside the metadata document must equal the document URL",
    );
  }
  if (!document.client_name || document.redirect_uris.length === 0) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "A client ID metadata document requires client_name and redirect_uris",
    );
  }
}
