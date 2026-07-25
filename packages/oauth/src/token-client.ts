import {
  GatewayError,
  formatScopes,
  isRecord,
  parseScopes,
  type AuthorizationServerMetadata,
  type Clock,
  type OAuthTokenResponse,
  type TokenEndpointAuthMethod,
} from "@umg/core";
import type { SafeFetcher, SigningKey } from "@umg/security";

import { CLIENT_ASSERTION_TYPE, createClientAssertion } from "./client-assertion.js";
import { createDpopProof, type DpopKey } from "./dpop.js";
import { OAuthProtocolError } from "./protocol-error.js";

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /** Required when the method is `private_key_jwt`. */
  signingKey?: SigningKey;
}

export interface AuthorizationUrlParams {
  metadata: AuthorizationServerMetadata;
  credentials: ClientCredentials;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
  /** RFC 8707 resource indicator identifying the MCP endpoint. */
  resource?: string | null;
  extraParams?: Record<string, string>;
}

export interface CodeExchangeParams {
  metadata: AuthorizationServerMetadata;
  credentials: ClientCredentials;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string | null;
  /** Binds the issued token to this key when the server supports DPoP. */
  dpopKey?: DpopKey | null;
}

export interface RefreshParams {
  metadata: AuthorizationServerMetadata;
  credentials: ClientCredentials;
  refreshToken: string;
  scopes?: readonly string[];
  resource?: string | null;
  dpopKey?: DpopKey | null;
}

export interface RevokeParams {
  metadata: AuthorizationServerMetadata;
  credentials: ClientCredentials;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
}

export interface NormalizedTokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  scopes: string[];
  raw: OAuthTokenResponse;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isDpopNonceError(payload: unknown): boolean {
  return isRecord(payload) && payload["error"] === "use_dpop_nonce";
}

/**
 * RFC 6749 section 2.3.1 requires the client id and secret to be encoded with
 * `application/x-www-form-urlencoded` before base64, which differs from
 * `encodeURIComponent` on space and on `!'()*`. Identical for the alphanumeric
 * credentials most servers issue, and the difference is the whole reason the
 * ones that issue punctuation are hard to debug.
 */
function formUrlEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

/**
 * RFC 8414: a server that advertises the methods it accepts has told us what
 * will work. Failing here names both sides, rather than leaving an operator
 * with a 401 that says nothing about which of the two is wrong.
 */
function assertMethodSupported(
  metadata: AuthorizationServerMetadata,
  method: TokenEndpointAuthMethod,
): void {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (!Array.isArray(supported) || supported.length === 0) return;
  if (supported.includes(method)) return;
  throw new GatewayError(
    "TOKEN_EXCHANGE_FAILED",
    `Authorization server does not accept ${method} at its token endpoint`,
    { data: { supported: supported.filter((entry) => typeof entry === "string") } },
  );
}

export class OAuthTokenClient {
  /** Latest DPoP nonce each token endpoint asked for, keyed by endpoint. */
  private readonly tokenNonces = new Map<string, string>();

  constructor(
    private readonly fetcher: SafeFetcher,
    private readonly clock: Clock,
  ) {}

  buildAuthorizationUrl(params: AuthorizationUrlParams): string {
    const endpoint = params.metadata.authorization_endpoint;
    if (!endpoint) {
      throw new GatewayError(
        "DISCOVERY_FAILED",
        "Authorization server has no authorization endpoint",
      );
    }
    const url = new URL(endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", params.credentials.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (params.scopes.length > 0) {
      url.searchParams.set("scope", formatScopes(params.scopes));
    }
    if (params.resource) url.searchParams.set("resource", params.resource);
    for (const [key, value] of Object.entries(params.extraParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async exchangeCode(params: CodeExchangeParams): Promise<NormalizedTokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    });
    if (params.resource) body.set("resource", params.resource);
    return this.postToken(params.metadata, params.credentials, body, params.dpopKey);
  }

  async refresh(params: RefreshParams): Promise<NormalizedTokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    });
    if (params.scopes && params.scopes.length > 0) {
      body.set("scope", formatScopes(params.scopes));
    }
    if (params.resource) body.set("resource", params.resource);
    return this.postToken(params.metadata, params.credentials, body, params.dpopKey);
  }

  async revoke(params: RevokeParams): Promise<void> {
    const endpoint = params.metadata.revocation_endpoint;
    if (!endpoint) return;
    const body = new URLSearchParams({ token: params.token });
    if (params.tokenTypeHint) body.set("token_type_hint", params.tokenTypeHint);
    const headers = this.applyClientAuthentication(
      params.metadata,
      params.credentials,
      body,
      endpoint,
    );
    const response = await this.fetcher.request({
      url: endpoint,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...headers,
      },
      body: body.toString(),
      followRedirects: false,
    });

    // RFC 7009 answers 200 for a token it revoked and for one it never issued.
    // Anything else means the token is still live, and a caller told otherwise
    // will report a credential as destroyed while it still works.
    if (response.status < 200 || response.status >= 300) {
      throw OAuthProtocolError.fromBody(
        response.status,
        parseJson(await response.text()),
        "invalid_request",
      );
    }
  }

  private async postToken(
    metadata: AuthorizationServerMetadata,
    credentials: ClientCredentials,
    body: URLSearchParams,
    dpopKey?: DpopKey | null,
  ): Promise<NormalizedTokenSet> {
    const endpoint = metadata.token_endpoint;
    if (!endpoint) {
      throw new GatewayError("DISCOVERY_FAILED", "Authorization server has no token endpoint");
    }
    // A server may refuse the first proof and hand back a nonce it wants
    // echoed. That is one prescribed round trip, not an error, so it is
    // retried once rather than surfaced.
    let nonce = dpopKey ? this.tokenNonces.get(endpoint) : undefined;
    for (let attempt = 0; ; attempt += 1) {
      // Rebuilt every attempt. A client assertion carries a jti and an iat, and
      // a server that tracks either rejects the second send of the first one --
      // which would turn the prescribed nonce round trip into a failure.
      const attemptBody = new URLSearchParams(body);
      const headers = this.applyClientAuthentication(
        metadata,
        credentials,
        attemptBody,
        endpoint,
      );

      const response = await this.fetcher.request({
        url: endpoint,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          ...headers,
          ...(dpopKey
            ? { dpop: this.proof(dpopKey, "POST", endpoint, nonce, undefined) }
            : {}),
        },
        body: attemptBody.toString(),
        followRedirects: false,
      });

      const text = await response.text();
      const payload = parseJson(text);

      if (response.status < 200 || response.status >= 300) {
        const issued = response.headers["dpop-nonce"];
        if (dpopKey && attempt === 0 && issued && isDpopNonceError(payload)) {
          this.tokenNonces.set(endpoint, issued);
          nonce = issued;
          continue;
        }
        throw OAuthProtocolError.fromBody(response.status, payload, "invalid_request");
      }
      const issued = response.headers["dpop-nonce"];
      if (dpopKey && issued) this.tokenNonces.set(endpoint, issued);

      if (!isRecord(payload) || typeof payload["access_token"] !== "string") {
        throw new GatewayError(
          "TOKEN_EXCHANGE_FAILED",
          "Token endpoint returned a response without an access token",
        );
      }
      return this.normalize(payload as unknown as OAuthTokenResponse);
    }
  }

  private proof(
    key: DpopKey,
    method: string,
    url: string,
    nonce: string | undefined,
    accessToken: string | undefined,
  ): string {
    return createDpopProof({
      key,
      htm: method,
      htu: url,
      nowSeconds: Math.floor(this.clock.now() / 1000),
      nonce,
      accessToken,
    });
  }

  private normalize(raw: OAuthTokenResponse): NormalizedTokenSet {
    const now = this.clock.now();
    return {
      accessToken: raw.access_token,
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
      tokenType: raw.token_type ?? "Bearer",
      expiresAt:
        typeof raw.expires_in === "number" ? now + raw.expires_in * 1000 : null,
      refreshTokenExpiresAt:
        typeof raw.refresh_token_expires_in === "number"
          ? now + raw.refresh_token_expires_in * 1000
          : null,
      scopes: parseScopes(typeof raw.scope === "string" ? raw.scope : null),
      raw,
    };
  }

  private applyClientAuthentication(
    metadata: AuthorizationServerMetadata,
    credentials: ClientCredentials,
    body: URLSearchParams,
    endpoint: string,
  ): Record<string, string> {
    assertMethodSupported(metadata, credentials.tokenEndpointAuthMethod);

    switch (credentials.tokenEndpointAuthMethod) {
      case "none":
        body.set("client_id", credentials.clientId);
        return {};
      case "client_secret_post":
        body.set("client_id", credentials.clientId);
        body.set("client_secret", credentials.clientSecret ?? "");
        return {};
      case "client_secret_basic": {
        const raw = `${formUrlEncode(credentials.clientId)}:${formUrlEncode(
          credentials.clientSecret ?? "",
        )}`;
        return { authorization: `Basic ${Buffer.from(raw).toString("base64")}` };
      }
      case "private_key_jwt": {
        if (!credentials.signingKey) {
          throw new GatewayError(
            "INTERNAL",
            "private_key_jwt selected without a signing key",
          );
        }
        body.set("client_id", credentials.clientId);
        body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
        body.set(
          "client_assertion",
          createClientAssertion({
            clientId: credentials.clientId,
            audience: endpoint,
            key: credentials.signingKey,
            nowSeconds: Math.floor(this.clock.now() / 1000),
          }),
        );
        return {};
      }
      default: {
        const exhaustive: never = credentials.tokenEndpointAuthMethod;
        void exhaustive;
        throw new GatewayError("INTERNAL", "Unsupported token endpoint auth method");
      }
    }
  }
}
