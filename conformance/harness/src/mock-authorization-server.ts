import {
  createHash,
  createPublicKey,
  createVerify,
  randomUUID,
  type JsonWebKey,
} from "node:crypto";
import type { ServerResponse } from "node:http";

import type { TokenEndpointAuthMethod } from "@umg/core";

import {
  HttpFixture,
  headerOf,
  json,
  redirect,
  type FixtureRequest,
} from "./http-fixture.js";
import { verifyDpopProof } from "./dpop-verifier.js";

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUris: string[];
  jwksUri: string | null;
  registrationType: "PRECONFIGURED" | "DYNAMIC" | "CIMD";
  secretExpiresAt: number | null;
}

export interface MockAuthorizationServerOptions {
  /** Advertise `client_id_metadata_document_supported`. */
  supportsCimd?: boolean;
  /** Advertise a `registration_endpoint`. */
  supportsDcr?: boolean;
  /** Reject dynamic registration unless a valid initial access token is sent. */
  initialAccessToken?: string | null;
  tokenEndpointAuthMethods?: TokenEndpointAuthMethod[];
  /** Seconds until a DCR-issued client secret expires; 0 means never. */
  clientSecretExpiresInSeconds?: number;
  issueRefreshToken?: boolean;
  rotateRefreshToken?: boolean;
  accessTokenTtlSeconds?: number;
  scopesSupported?: string[];
  /** Grant exactly these scopes regardless of what was requested. */
  fixedScopes?: string[] | null;
  requireResourceParameter?: boolean;
  supportsRevocation?: boolean;
  /** Advertise DPoP and bind issued tokens to the proof key. */
  supportsDpop?: boolean;
  /** Refuse the first proof at each endpoint to hand out a nonce, as RFC 9449 allows. */
  requireDpopNonce?: boolean;
  /** Serve discovery only at the OpenID Connect location. */
  discoveryStyle?: "oauth" | "openid";
  /** Extra members merged into the published metadata document. */
  metadataOverrides?: Record<string, unknown>;
}

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
  used: boolean;
}

interface Grant {
  id: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  refreshToken: string | null;
  /** Every refresh token this grant has ever issued, to detect replay. */
  retiredRefreshTokens: Set<string>;
  revoked: boolean;
}

interface AccessTokenRecord {
  grantId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
  /** JWK thumbprint the token is bound to, for a DPoP grant. */
  confirmation: string | null;
}

export interface TokenFailureInjection {
  /** How many upcoming token requests should fail. */
  count: number;
  status: number;
  error: string;
}

export interface AuthorizationServerStats {
  authorizeRequests: number;
  tokenRequests: number;
  codeExchanges: number;
  refreshes: number;
  registrations: number;
  revocations: number;
  metadataRequests: number;
}

const DEFAULTS = {
  tokenEndpointAuthMethods: ["none"] as TokenEndpointAuthMethod[],
  accessTokenTtlSeconds: 3600,
  scopesSupported: ["mcp:read", "mcp:write"],
};

/**
 * A standards-shaped OAuth 2.0 authorization server used to exercise the
 * gateway's OAuth engine. Every behavioural difference a real provider might
 * have (registration mechanism, client authentication method, refresh token
 * rotation, scope handling) is a constructor option rather than a separate
 * fixture, which mirrors how the gateway itself treats providers.
 */
export class MockAuthorizationServer {
  private readonly fixture: HttpFixture;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  /** Nonce this server last handed out per endpoint, when it demands one. */
  private readonly issuedNonces = new Map<string, string>();
  /** Proof identifiers already spent, so a replayed proof is caught. */
  private readonly seenProofIds = new Set<string>();
  private readonly refreshIndex = new Map<string, string>();
  private failures: TokenFailureInjection | null = null;
  private tokenDelayMs = 0;

  readonly stats: AuthorizationServerStats = {
    authorizeRequests: 0,
    tokenRequests: 0,
    codeExchanges: 0,
    refreshes: 0,
    registrations: 0,
    revocations: 0,
    metadataRequests: 0,
  };

  constructor(private readonly options: MockAuthorizationServerOptions = {}) {
    this.fixture = new HttpFixture((request, res) => this.route(request, res));
  }

  get issuer(): string {
    return this.fixture.baseUrl;
  }

  async start(): Promise<string> {
    return this.fixture.start();
  }

  async stop(): Promise<void> {
    await this.fixture.stop();
  }

  /** Registers credentials an administrator would create in a developer portal. */
  preregisterClient(client: {
    clientId: string;
    clientSecret?: string | null;
    tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
    redirectUris?: string[];
  }): RegisteredClient {
    const record: RegisteredClient = {
      clientId: client.clientId,
      clientSecret: client.clientSecret ?? null,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod ?? "client_secret_basic",
      redirectUris: client.redirectUris ?? [],
      jwksUri: null,
      registrationType: "PRECONFIGURED",
      secretExpiresAt: null,
    };
    this.clients.set(record.clientId, record);
    return record;
  }

  failNextTokenRequests(injection: TokenFailureInjection): void {
    this.failures = { ...injection };
  }

  delayTokenResponses(ms: number): void {
    this.tokenDelayMs = ms;
  }

  /** Simulates the user revoking consent in the provider's own UI. */
  revokeAllGrants(): void {
    for (const grant of this.grants.values()) grant.revoked = true;
  }

  isRefreshTokenActive(token: string): boolean {
    const grantId = this.refreshIndex.get(token);
    if (!grantId) return false;
    const grant = this.grants.get(grantId);
    return grant !== undefined && !grant.revoked && grant.refreshToken === token;
  }

  activeRefreshTokens(): string[] {
    return [...this.grants.values()]
      .filter((grant) => !grant.revoked && grant.refreshToken !== null)
      .map((grant) => grant.refreshToken as string);
  }

  /** Used by the mock MCP server to authorize an incoming bearer token. */
  introspect(
    token: string,
    now = Date.now(),
  ): {
    active: boolean;
    scopes: string[];
    resource: string | null;
    confirmation: string | null;
  } {
    const inactive = { active: false, scopes: [], resource: null, confirmation: null };
    const record = this.accessTokens.get(token);
    if (!record) return inactive;
    const grant = this.grants.get(record.grantId);
    if (!grant || grant.revoked || record.expiresAt <= now) return inactive;
    return {
      active: true,
      scopes: record.scopes,
      resource: record.resource,
      confirmation: record.confirmation,
    };
  }

  /** Expires every issued access token without touching the refresh tokens. */
  expireAccessTokens(): void {
    for (const record of this.accessTokens.values()) record.expiresAt = 0;
  }

  /**
   * Expires every client secret this server issued. The grants survive; it is
   * the gateway's own client identity that has gone stale.
   */
  expireClientSecrets(): void {
    for (const client of this.clients.values()) {
      if (client.clientSecret !== null) client.secretExpiresAt = 1;
    }
  }

  metadata(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: this.options.scopesSupported ?? DEFAULTS.scopesSupported,
      token_endpoint_auth_methods_supported:
        this.options.tokenEndpointAuthMethods ?? DEFAULTS.tokenEndpointAuthMethods,
      resource_indicators_supported: true,
    };
    if (this.options.supportsCimd) base["client_id_metadata_document_supported"] = true;
    if (this.options.supportsDcr) base["registration_endpoint"] = `${this.issuer}/register`;
    if (this.options.supportsRevocation !== false) {
      base["revocation_endpoint"] = `${this.issuer}/revoke`;
    }
    if (this.options.supportsDpop) {
      base["dpop_signing_alg_values_supported"] = ["ES256"];
    }
    return { ...base, ...(this.options.metadataOverrides ?? {}) };
  }

  private async route(request: FixtureRequest, res: ServerResponse): Promise<void> {
    const path = request.url.pathname;
    const style = this.options.discoveryStyle ?? "oauth";
    const metadataPath =
      style === "openid"
        ? "/.well-known/openid-configuration"
        : "/.well-known/oauth-authorization-server";

    if (request.method === "GET" && path === metadataPath) {
      this.stats.metadataRequests += 1;
      json(res, 200, this.metadata(), { "cache-control": "no-store" });
      return;
    }
    if (request.method === "GET" && path === "/authorize") {
      await this.handleAuthorize(request, res);
      return;
    }
    if (request.method === "POST" && path === "/token") {
      await this.handleToken(request, res);
      return;
    }
    if (request.method === "POST" && path === "/register") {
      await this.handleRegister(request, res);
      return;
    }
    if (request.method === "POST" && path === "/revoke") {
      this.handleRevoke(request, res);
      return;
    }
  }

  private async handleAuthorize(
    request: FixtureRequest,
    res: ServerResponse,
  ): Promise<void> {
    this.stats.authorizeRequests += 1;
    const query = request.url.searchParams;
    const clientId = query.get("client_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";
    const state = query.get("state") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    const method = query.get("code_challenge_method") ?? "";
    const resource = query.get("resource");

    if (method !== "S256" || challenge === "") {
      json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
      return;
    }
    if (this.options.requireResourceParameter && !resource) {
      json(res, 400, {
        error: "invalid_target",
        error_description: "A resource indicator is required",
      });
      return;
    }
    const client = this.clients.get(clientId) ?? (await this.resolveCimdClient(clientId));
    if (!client) {
      json(res, 400, { error: "invalid_client", error_description: "Unknown client" });
      return;
    }
    if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
      json(res, 400, {
        error: "invalid_request",
        error_description: "redirect_uri is not registered",
      });
      return;
    }

    const requested = (query.get("scope") ?? "").split(" ").filter(Boolean);
    const code: AuthorizationCode = {
      code: `code_${randomUUID()}`,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      scopes: this.options.fixedScopes ?? requested,
      resource,
      used: false,
    };
    this.codes.set(code.code, code);

    const location = new URL(redirectUri);
    location.searchParams.set("code", code.code);
    if (state) location.searchParams.set("state", state);
    location.searchParams.set("iss", this.issuer);
    redirect(res, location.toString());
  }

  private async handleToken(
    request: FixtureRequest,
    res: ServerResponse,
  ): Promise<void> {
    this.stats.tokenRequests += 1;
    if (this.tokenDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.tokenDelayMs));
    }
    if (this.failures && this.failures.count > 0) {
      this.failures.count -= 1;
      json(res, this.failures.status, { error: this.failures.error });
      return;
    }

    const body = new URLSearchParams(request.body);
    const client = await this.authenticateClient(request, body);
    if (!client) {
      json(res, 401, { error: "invalid_client" });
      return;
    }

    let confirmation: string | null = null;
    if (this.options.supportsDpop) {
      const outcome = this.checkProof(request, `${this.issuer}/token`, undefined);
      if (outcome.kind === "nonce") {
        json(
          res,
          400,
          { error: "use_dpop_nonce" },
          { "dpop-nonce": outcome.nonce },
        );
        return;
      }
      if (outcome.kind === "invalid") {
        json(res, 400, { error: "invalid_dpop_proof", error_description: outcome.reason });
        return;
      }
      confirmation = outcome.thumbprint;
    }

    switch (body.get("grant_type")) {
      case "authorization_code":
        this.exchangeCode(body, client, res, confirmation);
        return;
      case "refresh_token":
        this.refresh(body, client, res, confirmation);
        return;
      default:
        json(res, 400, { error: "unsupported_grant_type" });
    }
  }

  /**
   * Applies the server's DPoP policy to one request. The nonce dance is
   * per-endpoint: the first proof is refused with a nonce, and the retry
   * carrying it is accepted.
   */
  private checkProof(
    request: FixtureRequest,
    htu: string,
    accessToken: string | undefined,
  ):
    | { kind: "ok"; thumbprint: string }
    | { kind: "nonce"; nonce: string }
    | { kind: "invalid"; reason: string } {
    const proof = headerOf(request, "dpop");
    const expectedNonce = this.issuedNonces.get(htu);
    if (this.options.requireDpopNonce && expectedNonce === undefined) {
      const nonce = `nonce_${randomUUID()}`;
      this.issuedNonces.set(htu, nonce);
      return { kind: "nonce", nonce };
    }
    try {
      const verified = verifyDpopProof(proof, {
        htm: request.method,
        htu,
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(expectedNonce === undefined ? {} : { nonce: expectedNonce }),
      });
      if (this.seenProofIds.has(verified.jti)) {
        return { kind: "invalid", reason: "proof replayed" };
      }
      this.seenProofIds.add(verified.jti);
      return { kind: "ok", thumbprint: verified.thumbprint };
    } catch (error) {
      return { kind: "invalid", reason: (error as Error).message };
    }
  }

  private exchangeCode(
    body: URLSearchParams,
    client: RegisteredClient,
    res: ServerResponse,
    confirmation: string | null,
  ): void {
    const code = this.codes.get(body.get("code") ?? "");
    if (!code || code.clientId !== client.clientId) {
      json(res, 400, { error: "invalid_grant", error_description: "Unknown code" });
      return;
    }
    if (code.used) {
      json(res, 400, { error: "invalid_grant", error_description: "Code already used" });
      return;
    }
    const verifier = body.get("code_verifier") ?? "";
    if (pkceChallengeOf(verifier) !== code.codeChallenge) {
      json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      return;
    }
    if ((body.get("redirect_uri") ?? "") !== code.redirectUri) {
      json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    code.used = true;
    this.stats.codeExchanges += 1;

    const grant: Grant = {
      id: `grant_${randomUUID()}`,
      clientId: client.clientId,
      scopes: code.scopes,
      resource: body.get("resource") ?? code.resource,
      refreshToken: null,
      retiredRefreshTokens: new Set(),
      revoked: false,
    };
    this.grants.set(grant.id, grant);
    json(res, 200, this.issueTokens(grant, confirmation));
  }

  private refresh(
    body: URLSearchParams,
    client: RegisteredClient,
    res: ServerResponse,
    confirmation: string | null,
  ): void {
    const presented = body.get("refresh_token") ?? "";
    const grantId = this.refreshIndex.get(presented);
    const grant = grantId ? this.grants.get(grantId) : undefined;
    if (!grant || grant.clientId !== client.clientId) {
      json(res, 400, { error: "invalid_grant", error_description: "Unknown refresh token" });
      return;
    }
    if (grant.revoked) {
      json(res, 400, { error: "invalid_grant", error_description: "Grant revoked" });
      return;
    }
    if (grant.refreshToken !== presented) {
      // Replay of a rotated token: RFC 9700 says the whole family dies.
      grant.revoked = true;
      json(res, 400, {
        error: "invalid_grant",
        error_description: "Refresh token replay detected",
      });
      return;
    }
    this.stats.refreshes += 1;
    json(res, 200, this.issueTokens(grant, confirmation));
  }

  private issueTokens(
    grant: Grant,
    confirmation: string | null = null,
  ): Record<string, unknown> {
    const ttl = this.options.accessTokenTtlSeconds ?? DEFAULTS.accessTokenTtlSeconds;
    const accessToken = `at_${randomUUID()}`;
    this.accessTokens.set(accessToken, {
      grantId: grant.id,
      scopes: grant.scopes,
      resource: grant.resource,
      expiresAt: Date.now() + ttl * 1000,
      confirmation,
    });

    const payload: Record<string, unknown> = {
      access_token: accessToken,
      // A token bound to a key is useless without it, so the client is told to
      // present it as DPoP rather than as a bearer token.
      token_type: confirmation === null ? "Bearer" : "DPoP",
      expires_in: ttl,
      scope: grant.scopes.join(" "),
    };

    if (this.options.issueRefreshToken === false) {
      grant.refreshToken = null;
      return payload;
    }
    const rotate = this.options.rotateRefreshToken !== false;
    if (grant.refreshToken === null || rotate) {
      if (grant.refreshToken) grant.retiredRefreshTokens.add(grant.refreshToken);
      const refreshToken = `rt_${randomUUID()}`;
      grant.refreshToken = refreshToken;
      this.refreshIndex.set(refreshToken, grant.id);
      payload["refresh_token"] = refreshToken;
    }
    return payload;
  }

  private async handleRegister(
    request: FixtureRequest,
    res: ServerResponse,
  ): Promise<void> {
    this.stats.registrations += 1;
    if (!this.options.supportsDcr) {
      json(res, 404, { error: "not_found" });
      return;
    }
    if (this.options.initialAccessToken) {
      const authorization = headerOf(request, "authorization") ?? "";
      if (authorization !== `Bearer ${this.options.initialAccessToken}`) {
        json(res, 401, {
          error: "invalid_token",
          error_description: "Registration requires an initial access token",
        });
        return;
      }
    }

    const metadata = JSON.parse(request.body) as Record<string, unknown>;
    const requested = String(metadata["token_endpoint_auth_method"] ?? "none");
    const supported =
      this.options.tokenEndpointAuthMethods ?? DEFAULTS.tokenEndpointAuthMethods;
    const granted = (
      supported.includes(requested as TokenEndpointAuthMethod)
        ? requested
        : (supported[0] ?? "none")
    ) as TokenEndpointAuthMethod;
    const needsSecret =
      granted === "client_secret_basic" || granted === "client_secret_post";
    const expiresIn = this.options.clientSecretExpiresInSeconds ?? 0;

    const record: RegisteredClient = {
      clientId: `dcr_${randomUUID()}`,
      clientSecret: needsSecret ? `secret_${randomUUID()}` : null,
      tokenEndpointAuthMethod: granted,
      redirectUris: Array.isArray(metadata["redirect_uris"])
        ? (metadata["redirect_uris"] as string[])
        : [],
      jwksUri: typeof metadata["jwks_uri"] === "string" ? metadata["jwks_uri"] : null,
      registrationType: "DYNAMIC",
      secretExpiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    };
    this.clients.set(record.clientId, record);

    json(res, 201, {
      client_id: record.clientId,
      ...(record.clientSecret ? { client_secret: record.clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at:
        expiresIn > 0 ? Math.floor((Date.now() + expiresIn * 1000) / 1000) : 0,
      token_endpoint_auth_method: granted,
      redirect_uris: record.redirectUris,
    });
  }

  private handleRevoke(request: FixtureRequest, res: ServerResponse): void {
    this.stats.revocations += 1;
    const body = new URLSearchParams(request.body);
    const token = body.get("token") ?? "";
    const grantId = this.refreshIndex.get(token);
    const grant = grantId ? this.grants.get(grantId) : undefined;
    if (grant) grant.revoked = true;
    res.writeHead(200, { "content-length": 0 });
    res.end();
  }

  /**
   * Applies the client authentication method the client registered with. A
   * `client_id` that looks like an HTTPS/HTTP URL is treated as a Client ID
   * Metadata Document and resolved on first use.
   */
  private async authenticateClient(
    request: FixtureRequest,
    body: URLSearchParams,
  ): Promise<RegisteredClient | null> {
    const basic = parseBasicAuth(headerOf(request, "authorization"));
    const clientId = basic?.clientId ?? body.get("client_id") ?? "";
    if (!clientId) return null;

    const client = this.clients.get(clientId) ?? (await this.resolveCimdClient(clientId));
    if (!client) return null;
    if (client.secretExpiresAt !== null && client.secretExpiresAt <= Date.now()) {
      return null;
    }

    switch (client.tokenEndpointAuthMethod) {
      case "none":
        return client;
      case "client_secret_basic":
        return basic?.clientSecret === client.clientSecret ? client : null;
      case "client_secret_post":
        return body.get("client_secret") === client.clientSecret ? client : null;
      case "private_key_jwt":
        return (await this.verifyAssertion(client, body)) ? client : null;
      default:
        return null;
    }
  }

  /**
   * Fetches and validates a Client ID Metadata Document. The document URL is
   * the client identifier, so the two must match exactly.
   */
  private async resolveCimdClient(clientId: string): Promise<RegisteredClient | null> {
    if (!this.options.supportsCimd) return null;
    if (!clientId.startsWith("https://") && !clientId.startsWith("http://")) return null;
    const url = new URL(clientId);
    if (url.pathname === "" || url.pathname === "/") return null;

    let document: Record<string, unknown>;
    try {
      const response = await fetch(clientId, { headers: { accept: "application/json" } });
      if (!response.ok) return null;
      document = (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (document["client_id"] !== clientId) return null;
    if (!Array.isArray(document["redirect_uris"])) return null;

    const method = String(document["token_endpoint_auth_method"] ?? "none");
    const supported =
      this.options.tokenEndpointAuthMethods ?? DEFAULTS.tokenEndpointAuthMethods;
    const record: RegisteredClient = {
      clientId,
      clientSecret: null,
      tokenEndpointAuthMethod: (supported.includes(method as TokenEndpointAuthMethod)
        ? method
        : "none") as TokenEndpointAuthMethod,
      redirectUris: document["redirect_uris"] as string[],
      jwksUri: typeof document["jwks_uri"] === "string" ? document["jwks_uri"] : null,
      registrationType: "CIMD",
      secretExpiresAt: null,
    };
    this.clients.set(clientId, record);
    return record;
  }

  /** Verifies an RFC 7523 assertion against the client's published JWKS. */
  private async verifyAssertion(
    client: RegisteredClient,
    body: URLSearchParams,
  ): Promise<boolean> {
    const assertion = body.get("client_assertion");
    if (!assertion || !client.jwksUri) return false;
    const [encodedHeader, encodedPayload, encodedSignature] = assertion.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return false;

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString()) as Record<
        string,
        unknown
      >;
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as Record<
        string,
        unknown
      >;
    } catch {
      return false;
    }
    if (payload["iss"] !== client.clientId || payload["sub"] !== client.clientId) {
      return false;
    }
    if (payload["aud"] !== `${this.issuer}/token`) return false;
    if (typeof payload["exp"] !== "number" || payload["exp"] * 1000 <= Date.now()) {
      return false;
    }

    let keys: { kid?: string; [key: string]: unknown }[];
    try {
      const response = await fetch(client.jwksUri);
      const document = (await response.json()) as { keys?: Record<string, unknown>[] };
      keys = (document.keys ?? []) as { kid?: string }[];
    } catch {
      return false;
    }
    const jwk = keys.find((candidate) => candidate.kid === header["kid"]) ?? keys[0];
    if (!jwk) return false;

    try {
      const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      const verifier = createVerify("SHA256");
      verifier.update(`${encodedHeader}.${encodedPayload}`);
      return verifier.verify(
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(encodedSignature, "base64url"),
      );
    } catch {
      return false;
    }
  }
}

function pkceChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseBasicAuth(
  header: string | undefined,
): { clientId: string; clientSecret: string } | null {
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}
