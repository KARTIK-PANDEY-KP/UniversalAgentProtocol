import {
  GatewayError,
  clampText,
  jitteredBackoff,
  newId,
  randomToken,
  sha256Hex,
  sleep,
  uniqueStrings,
  type AuthorizationServerMetadata,
  type Clock,
  type JsonObject,
  type OAuthIssuerRecord,
  type OAuthTransaction,
  type UpstreamConnection,
  type UpstreamRequestTarget,
} from "@umg/core";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import {
  CircuitBreaker,
  canonicalIssuer,
  sameIssuer,
  type CredentialVault,
  type SigningKeyStore,
} from "@umg/security";
import type { GatewayStore } from "@umg/storage";

import type { GatewayIdentity } from "./client-metadata.js";
import {
  createDpopProof,
  dpopKeyFromPem,
  generateDpopKey,
  supportsDpop,
  type DpopKey,
} from "./dpop.js";
import { createPkcePair } from "./pkce.js";
import { classifyTokenFailure, OAuthProtocolError } from "./protocol-error.js";
import type { ResolvedClientRegistration } from "./registration.js";
import type {
  ClientCredentials,
  NormalizedTokenSet,
  OAuthTokenClient,
} from "./token-client.js";

export interface ConnectionRef {
  tenantId: string;
  connectionId: string;
}

export interface TokenManagerConfig {
  identity: GatewayIdentity;
  /** Refresh this long before the access token actually expires. */
  accessTokenSafetyWindowMs: number;
  transactionTtlMs: number;
  maxRefreshRetries: number;
}

export const DEFAULT_TOKEN_MANAGER_CONFIG: Omit<TokenManagerConfig, "identity"> = {
  accessTokenSafetyWindowMs: 60_000,
  transactionTtlMs: 600_000,
  maxRefreshRetries: 2,
};

export interface TokenManagerDeps {
  store: GatewayStore;
  vault: CredentialVault;
  tokenClient: OAuthTokenClient;
  signingKeys: SigningKeyStore;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  config: TokenManagerConfig;
}

export interface AuthorizationTransactionRequest {
  tenantId: string;
  userId: string;
  connectionId: string;
  issuerRecord: OAuthIssuerRecord;
  metadata: AuthorizationServerMetadata;
  registration: ResolvedClientRegistration;
  scopes: string[];
  resource: string | null;
  returnTo?: string | null;
}

export interface AuthorizationTransaction {
  transactionId: string;
  authorizationUrl: string;
}

export interface OAuthCallbackInput {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
  /** Identity of the signed-in user completing the callback, when known. */
  actingUserId?: string;
}

export interface CallbackResult {
  connectionId: string;
  tenantId: string;
  returnTo: string | null;
  grantedScopes: string[];
  refreshable: boolean;
}

export class OAuthTokenManager {
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** Decrypted DPoP keys, so a proof does not cost a decryption per request. */
  private readonly dpopKeys = new Map<string, DpopKey>();
  /** Latest nonce each upstream resource server demanded, keyed by connection. */
  private readonly resourceNonces = new Map<string, string>();

  constructor(private readonly deps: TokenManagerDeps) {}

  async createAuthorizationTransaction(
    request: AuthorizationTransactionRequest,
  ): Promise<AuthorizationTransaction> {
    const pkce = createPkcePair();
    const state = randomToken(32);
    const transaction: OAuthTransaction = {
      id: newId("txn"),
      tenantId: request.tenantId,
      userId: request.userId,
      connectionId: request.connectionId,
      issuer: canonicalIssuer(request.issuerRecord.issuer),
      stateHash: sha256Hex(state),
      pkceVerifierEncrypted: await this.deps.vault.encrypt(
        { tenantId: request.tenantId, purpose: "pkce_verifier" },
        pkce.verifier,
      ),
      redirectUri: this.deps.config.identity.redirectUri,
      requestedScopes: request.scopes,
      resource: request.resource,
      expiresAt: this.deps.clock.now() + this.deps.config.transactionTtlMs,
      consumedAt: null,
      status: "PENDING",
      returnTo: request.returnTo ?? null,
    };
    await this.deps.store.transactions.create(transaction);

    // The key has to exist before the code is exchanged, and it belongs to the
    // connection rather than the transaction so a refresh can reuse it.
    await this.ensureDpopKey(request.connectionId, request.tenantId, request.metadata);

    const authorizationUrl = this.deps.tokenClient.buildAuthorizationUrl({
      metadata: request.metadata,
      credentials: await this.credentialsFor(request.registration),
      redirectUri: transaction.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes: request.scopes,
      resource: request.resource,
    });

    this.deps.metrics.counter(Metric.OauthAuthorizationStarted, {
      registration_type: request.registration.registrationType,
    });
    this.deps.logger.info("Created OAuth authorization transaction", {
      tenantId: request.tenantId,
      connectionId: request.connectionId,
      issuer: request.issuerRecord.issuer,
      registrationType: request.registration.registrationType,
    });
    return { transactionId: transaction.id, authorizationUrl };
  }

  /**
   * Validates and consumes the authorization response, exchanges the code and
   * stores the resulting credentials. Every check that protects the
   * transaction happens here: expiry, single use, state binding, issuer
   * binding and the identity of the user completing the flow.
   */
  async exchangeCode(callback: OAuthCallbackInput): Promise<CallbackResult> {
    if (callback.error) {
      this.deps.metrics.counter(Metric.OauthAuthorizationFailed, {
        reason: callback.error,
      });
      throw new GatewayError(
        "TOKEN_EXCHANGE_FAILED",
        `Authorization server returned ${clampText(callback.error, 64)}`,
      );
    }
    if (!callback.state || !callback.code) {
      this.deps.metrics.counter(Metric.InvalidState, { reason: "missing" });
      throw new GatewayError("INVALID_REQUEST", "Missing authorization code or state");
    }

    const transaction = await this.deps.store.transactions.findByStateHash(
      sha256Hex(callback.state),
    );
    if (!transaction) {
      this.deps.metrics.counter(Metric.InvalidState, { reason: "unknown" });
      throw new GatewayError("INVALID_REQUEST", "Unknown authorization state");
    }
    if (transaction.expiresAt <= this.deps.clock.now()) {
      await this.deps.store.transactions.fail(transaction.id);
      throw new GatewayError("INVALID_REQUEST", "Authorization transaction expired");
    }
    if (
      callback.actingUserId !== undefined &&
      callback.actingUserId !== transaction.userId
    ) {
      this.deps.metrics.counter(Metric.TenantAccessDenied, { stage: "callback" });
      throw new GatewayError(
        "FORBIDDEN",
        "The signed-in user does not own this authorization transaction",
      );
    }
    await this.assertResponseIssuer(transaction, callback.iss);

    const connection = await this.deps.store.connections.get(
      transaction.tenantId,
      transaction.connectionId,
    );
    if (!connection) {
      await this.deps.store.transactions.fail(transaction.id);
      throw new GatewayError("NOT_FOUND", "Connection no longer exists");
    }

    const consumed = await this.deps.store.transactions.consume(
      transaction.id,
      this.deps.clock.now(),
    );
    if (!consumed) {
      this.deps.metrics.counter(Metric.InvalidState, { reason: "replay" });
      throw new GatewayError(
        "CONFLICT",
        "This authorization response was already processed",
      );
    }

    const { metadata, credentials } = await this.resolveClientContext(connection);
    const verifier = await this.deps.vault.decrypt(
      { tenantId: transaction.tenantId, purpose: "pkce_verifier" },
      transaction.pkceVerifierEncrypted,
    );

    let tokens: NormalizedTokenSet;
    try {
      tokens = await this.deps.tokenClient.exchangeCode({
        metadata,
        credentials,
        code: callback.code,
        codeVerifier: verifier,
        redirectUri: transaction.redirectUri,
        resource: transaction.resource,
        dpopKey: await this.dpopKeyFor(connection),
      });
    } catch (error) {
      this.deps.metrics.counter(Metric.OauthAuthorizationFailed, {
        reason: error instanceof OAuthProtocolError ? error.error : "exchange_failed",
      });
      await this.recordConnectionError(connection.id, error);
      throw new GatewayError(
        "TOKEN_EXCHANGE_FAILED",
        "The authorization code could not be exchanged",
        { cause: error },
      );
    }

    const grantedScopes =
      tokens.scopes.length > 0 ? tokens.scopes : transaction.requestedScopes;
    await this.persistTokens(connection, tokens, grantedScopes);

    this.deps.metrics.counter(Metric.OauthAuthorizationCompleted, {});
    return {
      connectionId: connection.id,
      tenantId: connection.tenantId,
      returnTo: transaction.returnTo,
      grantedScopes,
      refreshable: tokens.refreshToken !== null,
    };
  }

  /**
   * Enforces RFC 9207. An authorization server that advertises the `iss`
   * parameter has to send it: accepting a response without one from such a
   * server is exactly the mix-up attack the parameter exists to stop, where a
   * malicious server relays a code it obtained from an honest one.
   */
  private async assertResponseIssuer(
    transaction: OAuthTransaction,
    iss: string | undefined,
  ): Promise<void> {
    const reject = (reason: string): never => {
      this.deps.metrics.counter(Metric.InvalidIssuer, { stage: "callback" });
      throw new GatewayError("ISSUER_MISMATCH", reason);
    };
    if (iss !== undefined) {
      if (!sameIssuer(iss, transaction.issuer)) {
        reject("Authorization response came from an unexpected issuer");
      }
      return;
    }
    const record = await this.deps.store.issuers.findByIssuer(
      canonicalIssuer(transaction.issuer),
    );
    const metadata = record?.metadataJson as AuthorizationServerMetadata | undefined;
    if (metadata?.authorization_response_iss_parameter_supported === true) {
      reject(
        "The authorization server publishes an issuer identifier on its " +
          "responses, and this response carries none",
      );
    }
  }

  /**
   * Returns a usable upstream access token, refreshing under a connection
   * scoped lock when required. Concurrent callers collapse onto a single
   * provider refresh and observe the rotated token.
   *
   * `minRemainingMs` lets a caller demand more headroom than the default
   * safety window. The background worker uses it to renew tokens ahead of an
   * interactive request; because the refresh still runs under the same lock
   * and compare-and-swap, a scheduled renewal and a live request cannot
   * rotate the refresh token twice.
   */
  async getValidAccessToken(
    ref: ConnectionRef,
    options: { minRemainingMs?: number } = {},
  ): Promise<string> {
    const headroom = Math.max(
      options.minRemainingMs ?? 0,
      this.deps.config.accessTokenSafetyWindowMs,
    );
    const connection = await this.requireConnection(ref);
    this.assertUsable(connection);

    if (this.isAccessTokenUsable(connection, headroom)) {
      return this.decryptAccessToken(connection);
    }
    if (!connection.refreshTokenEncrypted) {
      // Without a refresh token an expired grant can only be repaired by the
      // user, but a token that merely lacks the requested headroom is still
      // perfectly usable right now.
      if (this.isAccessTokenUsable(connection)) {
        return this.decryptAccessToken(connection);
      }
      await this.markReauthRequired(connection, "access_token_expired");
      throw this.authorizationRequired(connection, "The access token expired");
    }

    return this.deps.store.locks.withLock(
      `oauth-refresh:${connection.id}`,
      async () => {
        const latest = await this.requireConnection(ref);
        this.assertUsable(latest);
        if (this.isAccessTokenUsable(latest, headroom)) {
          return this.decryptAccessToken(latest);
        }
        return this.refreshLocked(latest);
      },
      { leaseMs: 30_000, waitMs: 20_000 },
    );
  }

  /**
   * Headers to attach to an upstream MCP request. A DPoP proof is bound to the
   * method and URI of one request, so the caller has to say which request it
   * is about to make.
   */
  async authorizationHeaders(
    ref: ConnectionRef,
    request: UpstreamRequestTarget,
  ): Promise<Record<string, string>> {
    const connection = await this.requireConnection(ref);
    if (connection.staticHeadersEncrypted) {
      const raw = await this.deps.vault.decrypt(
        { tenantId: connection.tenantId, purpose: "static_headers" },
        connection.staticHeadersEncrypted,
      );
      return JSON.parse(raw) as Record<string, string>;
    }
    if (!connection.oauthIssuerId) return {};
    const token = await this.getValidAccessToken(ref);
    const scheme = connection.tokenType ?? "Bearer";
    if (scheme.toLowerCase() !== "dpop") {
      return { authorization: `${scheme} ${token}` };
    }

    const key = await this.dpopKeyFor(connection);
    if (!key) {
      throw new GatewayError(
        "INTERNAL",
        "The upstream issued a DPoP token but the binding key is missing",
      );
    }
    return {
      authorization: `DPoP ${token}`,
      dpop: createDpopProof({
        key,
        htm: request.method,
        htu: request.url,
        nowSeconds: Math.floor(this.deps.clock.now() / 1000),
        nonce: this.resourceNonces.get(connection.id),
        accessToken: token,
      }),
    };
  }

  /**
   * Records a nonce a resource server demanded. RFC 9449 lets the server
   * reject the first proof purely to hand one out, so the caller retries with
   * this recorded and succeeds.
   */
  rememberResourceNonce(connectionId: string, nonce: string): void {
    this.resourceNonces.set(connectionId, nonce);
  }

  /** Creates and stores a DPoP key when the server supports sender constraining. */
  private async ensureDpopKey(
    connectionId: string,
    tenantId: string,
    metadata: AuthorizationServerMetadata,
  ): Promise<void> {
    const connection = await this.deps.store.connections.get(tenantId, connectionId);
    if (!connection) return;
    if (!supportsDpop(metadata)) {
      if (connection.dpopKeyReference) {
        await this.deps.store.dpopKeys.delete(connection.dpopKeyReference);
        await this.deps.store.connections.update(connectionId, { dpopKeyReference: null });
      }
      return;
    }
    if (connection.dpopKeyReference) return;

    const { key, privateKeyPem } = generateDpopKey();
    const record = await this.deps.store.dpopKeys.create({
      id: newId("dpop"),
      tenantId,
      privateKeyEncrypted: await this.deps.vault.encrypt(
        { tenantId, purpose: "dpop_key" },
        privateKeyPem,
      ),
      publicJwkJson: key.publicJwk as JsonObject,
      createdAt: this.deps.clock.now(),
    });
    await this.deps.store.connections.update(connectionId, {
      dpopKeyReference: record.id,
    });
  }

  private async dpopKeyFor(connection: UpstreamConnection): Promise<DpopKey | null> {
    if (!connection.dpopKeyReference) return null;
    const cached = this.dpopKeys.get(connection.dpopKeyReference);
    if (cached) return cached;

    const record = await this.deps.store.dpopKeys.get(connection.dpopKeyReference);
    if (!record) return null;
    const key = dpopKeyFromPem(
      await this.deps.vault.decrypt(
        { tenantId: record.tenantId, purpose: "dpop_key" },
        record.privateKeyEncrypted,
      ),
    );
    this.dpopKeys.set(record.id, key);
    return key;
  }

  async revokeConnection(ref: ConnectionRef): Promise<void> {
    const connection = await this.requireConnection(ref);
    if (!connection.oauthIssuerId) return;
    try {
      const { metadata, credentials } = await this.resolveClientContext(connection);
      const refreshToken = await this.deps.vault.decryptOptional(
        { tenantId: connection.tenantId, purpose: "refresh_token" },
        connection.refreshTokenEncrypted,
      );
      if (refreshToken) {
        await this.deps.tokenClient.revoke({
          metadata,
          credentials,
          token: refreshToken,
          tokenTypeHint: "refresh_token",
        });
      }
    } catch (error) {
      this.deps.logger.warn("Upstream revocation failed", {
        connectionId: connection.id,
        error: (error as Error).message,
      });
    } finally {
      await this.deps.store.connections.update(connection.id, {
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        status: "REAUTH_REQUIRED",
        tokenVersion: connection.tokenVersion + 1,
      });
    }
  }

  /** Marks a connection as needing a wider grant after an insufficient_scope error. */
  async requireIncrementalAuthorization(
    ref: ConnectionRef,
    requiredScopes: string[],
  ): Promise<never> {
    const connection = await this.requireConnection(ref);
    await this.deps.store.connections.update(connection.id, {
      status: "REAUTH_REQUIRED",
      // Remembered so the next authorization asks for the wider grant rather
      // than repeating the request that was just refused.
      requestedScopes: uniqueStrings([...connection.requestedScopes, ...requiredScopes]),
      lastErrorCode: "insufficient_scope",
      lastErrorMessageRedacted: `Additional scopes required: ${requiredScopes.join(" ")}`,
    });
    this.deps.metrics.counter(Metric.OauthReauthRequired, { reason: "insufficient_scope" });
    throw this.authorizationRequired(
      connection,
      "The upstream server requires additional scopes",
    );
  }

  private async refreshLocked(connection: UpstreamConnection): Promise<string> {
    const breaker = this.breakerFor(connection.id);
    if (breaker.isOpen()) {
      throw new GatewayError(
        "UPSTREAM_UNAVAILABLE",
        "Token refresh is temporarily disabled after repeated failures",
        { retryable: true },
      );
    }

    const refreshToken = await this.deps.vault.decrypt(
      { tenantId: connection.tenantId, purpose: "refresh_token" },
      connection.refreshTokenEncrypted ?? "",
    );
    const { metadata, credentials, resource } = await this.resolveClientContext(connection);
    const dpopKey = await this.dpopKeyFor(connection);

    let attempt = 0;
    for (;;) {
      try {
        const tokens = await this.deps.tokenClient.refresh({
          metadata,
          credentials,
          refreshToken,
          resource,
          dpopKey,
        });
        breaker.recordSuccess();
        this.deps.metrics.counter(Metric.OauthTokenRefresh, {});
        const scopes =
          tokens.scopes.length > 0 ? tokens.scopes : connection.grantedScopes;
        const stored = await this.persistTokens(connection, tokens, scopes);
        if (!stored) {
          // Another worker rotated first; use whatever is now current.
          const latest = await this.requireConnection({
            tenantId: connection.tenantId,
            connectionId: connection.id,
          });
          return this.decryptAccessToken(latest);
        }
        return tokens.accessToken;
      } catch (error) {
        const kind = classifyTokenFailure(error);
        this.deps.metrics.counter(Metric.OauthTokenRefreshFailed, { kind });
        if (kind === "TRANSIENT" && attempt < this.deps.config.maxRefreshRetries) {
          attempt += 1;
          await sleep(jitteredBackoff(attempt));
          continue;
        }
        breaker.recordFailure();
        await this.applyRefreshFailure(connection, kind, error);
        throw this.refreshError(connection, kind, error);
      }
    }
  }

  private async applyRefreshFailure(
    connection: UpstreamConnection,
    kind: ReturnType<typeof classifyTokenFailure>,
    error: unknown,
  ): Promise<void> {
    switch (kind) {
      case "REAUTH_REQUIRED":
      case "INSUFFICIENT_SCOPE":
        await this.markReauthRequired(
          connection,
          error instanceof OAuthProtocolError ? error.error : "invalid_grant",
        );
        return;
      case "CLIENT_INVALID":
        if (connection.oauthClientRegistrationId) {
          await this.deps.store.registrations.update(
            connection.oauthClientRegistrationId,
            { status: "INVALID" },
          );
        }
        await this.markReauthRequired(connection, "invalid_client");
        return;
      case "TRANSIENT":
        // The grant is probably intact: keep the refresh token and degrade.
        await this.deps.store.connections.update(connection.id, {
          status: connection.status === "CONNECTED" ? "DEGRADED" : connection.status,
          lastErrorCode: "temporarily_unavailable",
          lastErrorMessageRedacted: clampText((error as Error).message, 200),
        });
        return;
      default: {
        const exhaustive: never = kind;
        void exhaustive;
      }
    }
  }

  private refreshError(
    connection: UpstreamConnection,
    kind: ReturnType<typeof classifyTokenFailure>,
    error: unknown,
  ): GatewayError {
    if (kind === "TRANSIENT") {
      return new GatewayError(
        "UPSTREAM_UNAVAILABLE",
        "The authorization server could not be reached to refresh the connection",
        { cause: error, retryable: true },
      );
    }
    return this.authorizationRequired(
      connection,
      "This connection requires authorization again",
    );
  }

  private async markReauthRequired(
    connection: UpstreamConnection,
    code: string,
  ): Promise<void> {
    await this.deps.store.connections.update(connection.id, {
      status: "REAUTH_REQUIRED",
      lastErrorCode: code,
      lastErrorMessageRedacted: "Reconnect this MCP server",
    });
    this.deps.metrics.counter(Metric.OauthReauthRequired, { reason: code });
  }

  private authorizationRequired(
    connection: UpstreamConnection,
    message: string,
  ): GatewayError {
    return new GatewayError("AUTHORIZATION_REQUIRED", message, {
      data: {
        connection_id: connection.id,
        alias: connection.alias,
        reconnect_url: `${this.deps.config.identity.baseUrl}/connect/${connection.id}`,
      },
    });
  }

  /**
   * Persists a token set with a compare-and-swap on the token version so a
   * rotated refresh token replaces the previous one exactly once.
   */
  private async persistTokens(
    connection: UpstreamConnection,
    tokens: NormalizedTokenSet,
    scopes: string[],
  ): Promise<boolean> {
    const tenantId = connection.tenantId;
    const accessTokenEncrypted = await this.deps.vault.encrypt(
      { tenantId, purpose: "access_token" },
      tokens.accessToken,
    );
    const refreshTokenEncrypted = tokens.refreshToken
      ? await this.deps.vault.encrypt(
          { tenantId, purpose: "refresh_token" },
          tokens.refreshToken,
        )
      : connection.refreshTokenEncrypted;

    return this.deps.store.connections.updateTokens({
      connectionId: connection.id,
      expectedTokenVersion: connection.tokenVersion,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      tokenType: tokens.tokenType,
      accessTokenExpiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      grantedScopes: uniqueStrings(scopes),
      status: refreshTokenEncrypted ? "CONNECTED" : "CONNECTED_NON_REFRESHABLE",
      lastRefreshAt: this.deps.clock.now(),
    });
  }

  private async resolveClientContext(connection: UpstreamConnection): Promise<{
    metadata: AuthorizationServerMetadata;
    credentials: ClientCredentials;
    resource: string | null;
  }> {
    if (!connection.oauthIssuerId || !connection.oauthClientRegistrationId) {
      throw new GatewayError(
        "INTERNAL",
        "Connection has no OAuth issuer or client registration",
      );
    }
    const issuer = await this.deps.store.issuers.get(connection.oauthIssuerId);
    const registration = await this.deps.store.registrations.get(
      connection.oauthClientRegistrationId,
    );
    if (!issuer || !registration) {
      throw new GatewayError("INTERNAL", "Connection references missing OAuth records");
    }
    const server = await this.deps.store.mcpServers.get(
      connection.tenantId,
      connection.mcpServerId,
    );
    const clientSecret = await this.deps.vault.decryptOptional(
      { tenantId: connection.tenantId, purpose: "client_secret" },
      registration.encryptedClientSecret,
    );
    return {
      metadata: issuer.metadataJson as unknown as AuthorizationServerMetadata,
      credentials: this.buildCredentials(registration.clientId, clientSecret, registration.tokenEndpointAuthMethod),
      resource: server?.canonicalResource ?? null,
    };
  }

  private async credentialsFor(
    registration: ResolvedClientRegistration,
  ): Promise<ClientCredentials> {
    return this.buildCredentials(
      registration.clientId,
      registration.clientSecret,
      registration.tokenEndpointAuthMethod,
    );
  }

  private buildCredentials(
    clientId: string,
    clientSecret: string | null,
    method: ClientCredentials["tokenEndpointAuthMethod"],
  ): ClientCredentials {
    const credentials: ClientCredentials = {
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: method,
    };
    if (method === "private_key_jwt") {
      credentials.signingKey = this.deps.signingKeys.active();
    }
    return credentials;
  }

  private breakerFor(connectionId: string): CircuitBreaker {
    const existing = this.breakers.get(connectionId);
    if (existing) return existing;
    const breaker = new CircuitBreaker(5, 30_000, () => this.deps.clock.now());
    this.breakers.set(connectionId, breaker);
    return breaker;
  }

  private isAccessTokenUsable(
    connection: UpstreamConnection,
    headroomMs = this.deps.config.accessTokenSafetyWindowMs,
  ): boolean {
    if (!connection.accessTokenEncrypted) return false;
    if (connection.accessTokenExpiresAt === null) return true;
    return connection.accessTokenExpiresAt - headroomMs > this.deps.clock.now();
  }

  private assertUsable(connection: UpstreamConnection): void {
    if (connection.status === "REAUTH_REQUIRED") {
      throw this.authorizationRequired(
        connection,
        "This connection requires authorization again",
      );
    }
    if (connection.status === "DISABLED") {
      throw new GatewayError("FORBIDDEN", "This connection is disabled");
    }
  }

  private async decryptAccessToken(connection: UpstreamConnection): Promise<string> {
    return this.deps.vault.decrypt(
      { tenantId: connection.tenantId, purpose: "access_token" },
      connection.accessTokenEncrypted ?? "",
    );
  }

  private async requireConnection(ref: ConnectionRef): Promise<UpstreamConnection> {
    const connection = await this.deps.store.connections.get(
      ref.tenantId,
      ref.connectionId,
    );
    if (!connection) {
      this.deps.metrics.counter(Metric.TenantAccessDenied, { stage: "connection" });
      throw new GatewayError("NOT_FOUND", "Connection not found");
    }
    return connection;
  }

  private async recordConnectionError(
    connectionId: string,
    error: unknown,
  ): Promise<void> {
    await this.deps.store.connections.update(connectionId, {
      lastErrorCode:
        error instanceof OAuthProtocolError ? error.error : "token_exchange_failed",
      lastErrorMessageRedacted: clampText((error as Error).message, 200),
    });
  }
}
