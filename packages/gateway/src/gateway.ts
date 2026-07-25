import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  GatewayError,
  clampText,
  constantTimeEquals,
  isRecord,
  newId,
  safeJsonParse,
  systemClock,
  toGatewayError,
  type Clock,
  type McpImplementation,
} from "@umg/core";
import {
  AuditService,
  ConnectionService,
  GatewayMcpHandler,
  PolicyEngine,
  UpstreamSessionManager,
  DEFAULT_TOOL_POLICY,
  type ToolPolicy,
} from "@umg/federation";
import {
  NorthboundMcpServer,
  headerValue,
  type AuthenticationOutcome,
  type BearerChallenge,
  type NorthboundPrincipal,
} from "@umg/mcp-server";
import {
  DEFAULT_TOKEN_MANAGER_CONFIG,
  OAuthDiscoveryService,
  OAuthTokenClient,
  OAuthTokenManager,
  RegistrationSelector,
  ResourceServerAuthenticator,
  buildClientIdMetadataDocument,
  gatewayIdentityFromBaseUrl,
  type GatewayIdentity,
  type VerifiedAccessToken,
} from "@umg/oauth";
import {
  MetricsRegistry,
  createLogger,
  type LogSink,
  type Logger,
} from "@umg/observability";
import {
  CredentialVault,
  LocalKeyring,
  RateLimiter,
  SafeFetcher,
  SigningKeyStore,
  STRICT_SSRF_POLICY,
} from "@umg/security";
import { SqliteGatewayStore, type GatewayStore } from "@umg/storage";

import { loadConfig, type ApiKeyPrincipal, type GatewayConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { Router } from "./router.js";

export const GATEWAY_SERVER_INFO: McpImplementation = {
  name: "universal-mcp-gateway",
  title: "Universal MCP Gateway",
  version: "0.1.0",
};

export interface GatewayOptions {
  config?: Partial<GatewayConfig>;
  clock?: Clock;
  logSink?: LogSink;
  policy?: Partial<ToolPolicy>;
}

export interface GatewayServices {
  config: GatewayConfig;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  store: GatewayStore;
  vault: CredentialVault;
  fetcher: SafeFetcher;
  signingKeys: SigningKeyStore;
  identity: GatewayIdentity;
  discovery: OAuthDiscoveryService;
  registrations: RegistrationSelector;
  tokenManager: OAuthTokenManager;
  upstreamSessions: UpstreamSessionManager;
  connections: ConnectionService;
  handler: GatewayMcpHandler;
  northbound: NorthboundMcpServer;
  policy: PolicyEngine;
  audit: AuditService;
  /** Validates bearer tokens minted by the operator's authorization servers. */
  resourceServer: ResourceServerAuthenticator;
  /** Caps control-plane requests per tenant. */
  apiLimiter: RateLimiter;
  /** Caps tool calls per tenant. */
  toolCallLimiter: RateLimiter;
}

/**
 * Composition root. Every dependency is constructed here so the individual
 * packages stay free of global state and can be tested in isolation.
 */
export class Gateway {
  readonly services: GatewayServices;
  private readonly router: Router;
  private server: Server | null = null;

  constructor(options: GatewayOptions = {}) {
    const config: GatewayConfig = { ...loadConfig(), ...(options.config ?? {}) };
    const clock = options.clock ?? systemClock;
    const logger = createLogger({
      level: config.logLevel,
      ...(options.logSink ? { sink: options.logSink } : {}),
      bindings: { service: "universal-mcp-gateway" },
    });
    const metrics = new MetricsRegistry();

    const store = new SqliteGatewayStore({
      filename: config.databaseFile,
      now: () => clock.now(),
    });
    const keyring = config.encryptionKeyRing
      ? LocalKeyring.fromSpec(config.encryptionKeyRing)
      : LocalKeyring.generate();
    const vault = new CredentialVault(keyring, metrics);
    const fetcher = new SafeFetcher(
      {
        ...STRICT_SSRF_POLICY,
        allowHttp: config.allowHttp,
        allowLoopback: config.allowLoopback,
        allowPrivateNetworks: config.allowPrivateNetworks,
        hostAllowlist: config.hostAllowlist,
        timeoutMs: config.requestTimeoutMs,
      },
      metrics,
    );
    const signingKeys = SigningKeyStore.generate(() => clock.now());
    const identity = gatewayIdentityFromBaseUrl(config.baseUrl, {
      ...(config.logoUri ? { logoUri: config.logoUri } : {}),
    });

    const discovery = new OAuthDiscoveryService({
      fetcher,
      store,
      clock,
      logger,
      metrics,
      allowHttp: config.allowHttp,
    });
    const tokenClient = new OAuthTokenClient(fetcher, clock);
    const registrations = new RegistrationSelector({
      store,
      vault,
      fetcher,
      identity,
      signingKeys,
      clock,
      logger,
      metrics,
    });
    const tokenManager = new OAuthTokenManager({
      store,
      vault,
      tokenClient,
      signingKeys,
      clock,
      logger,
      metrics,
      config: {
        ...DEFAULT_TOKEN_MANAGER_CONFIG,
        identity,
        transactionTtlMs: config.authorizationTransactionTtlMs,
      },
    });

    const policy = new PolicyEngine({
      ...DEFAULT_TOOL_POLICY,
      writeRoles: config.writeRoles,
      blockedRiskLevels: config.blockedRiskLevels,
      confirmationRiskLevels: config.confirmationRiskLevels,
      disableUnknownDestructive: !config.exposeUnreviewedDestructive,
      maxArgumentBytes: config.maxArgumentBytes,
      maxResultBytes: config.maxResultBytes,
      allowSampling: config.allowSampling,
      allowElicitation: config.allowElicitation,
      ...(options.policy ?? {}),
    });
    const resourceServer = new ResourceServerAuthenticator({
      discovery,
      fetcher,
      clock,
      logger,
      issuers: config.gatewayAuthorizationServers,
      resource: `${config.baseUrl}/mcp`,
      requiredScopes: config.gatewayRequiredScopes,
      allowHttp: config.allowHttp,
    });
    const perMinute = (limit: number): RateLimiter =>
      new RateLimiter({ limit, intervalMs: 60_000 }, () => clock.now());
    const apiLimiter = perMinute(config.apiRequestsPerMinute);
    const toolCallLimiter = perMinute(config.toolCallsPerMinute);
    const audit = new AuditService(store, clock, logger);

    // The session manager and the MCP handler reference each other: upstream
    // messages must be routed back to the downstream session that caused them.
    let handlerRef: GatewayMcpHandler | null = null;
    const upstreamSessions = new UpstreamSessionManager({
      store,
      vault,
      tokenManager,
      fetcher,
      logger,
      metrics,
      clock,
      clientInfo: GATEWAY_SERVER_INFO,
      clientCapabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      requestTimeoutMs: config.requestTimeoutMs,
      onNotification: (context, notification) => {
        handlerRef?.routeUpstreamNotification(context, notification);
      },
      onServerRequest: async (context, request) => {
        if (!handlerRef) {
          throw new GatewayError("INTERNAL", "Gateway handler is not ready");
        }
        return handlerRef.routeUpstreamRequest(context, request);
      },
    });

    let northboundRef: NorthboundMcpServer | null = null;
    const connections = new ConnectionService({
      store,
      vault,
      fetcher,
      discovery,
      registrations,
      tokenManager,
      sessions: upstreamSessions,
      policy,
      audit,
      clock,
      logger,
      metrics,
      identity,
      clientInfo: GATEWAY_SERVER_INFO,
      allowHttp: config.allowHttp,
      onCatalogueChanged: (tenantId, changed) => {
        handlerRef?.notifyCatalogueChanged(tenantId, changed);
      },
    });

    const handler = new GatewayMcpHandler({
      store,
      sessions: upstreamSessions,
      tokenManager,
      toolCallLimiter,
      apiLimiter,
      pageSize: config.pageSize,
      policy,
      audit,
      clock,
      logger,
      metrics,
      serverInfo: GATEWAY_SERVER_INFO,
      instructions:
        "Tools are named alias.tool and are federated from the remote MCP servers connected to this gateway.",
      lookupSession: (sessionId) => northboundRef?.getSession(sessionId),
      sessionsForTenant: (tenantId) => northboundRef?.sessionsForTenant(tenantId) ?? [],
    });
    handlerRef = handler;

    const northbound = new NorthboundMcpServer({
      handler,
      authenticate: (req) => this.authenticate(req),
      allowedOrigins: config.allowedOrigins,
      logger,
      metrics,
      clock,
      serverInfo: GATEWAY_SERVER_INFO,
      resourceMetadataUrl: `${config.baseUrl}/.well-known/oauth-protected-resource`,
    });
    northboundRef = northbound;

    this.services = {
      config,
      clock,
      logger,
      metrics,
      store,
      vault,
      fetcher,
      signingKeys,
      identity,
      discovery,
      registrations,
      tokenManager,
      upstreamSessions,
      connections,
      handler,
      northbound,
      policy,
      audit,
      resourceServer,
      apiLimiter,
      toolCallLimiter,
    };

    this.router = new Router();
    registerRoutes(this.router, this.services, (req) => this.authenticate(req));
    void this.ensurePrincipals();
  }

  get clientMetadataDocument(): ReturnType<typeof buildClientIdMetadataDocument> {
    return buildClientIdMetadataDocument(this.services.identity);
  }

  /** Creates the tenant and user rows backing the configured API keys. */
  private async ensurePrincipals(): Promise<void> {
    for (const principal of this.services.config.apiKeys) {
      await this.provisionMember({
        tenantId: principal.tenantId,
        userId: principal.userId,
        role: principal.role,
        email: `${principal.userId}@example.invalid`,
      });
    }
  }

  /**
   * Makes sure the tenant, user and membership rows behind a credential exist,
   * so a caller who authenticates does not then trip over a missing row.
   *
   * Two requests arriving together will both see the rows missing and both try
   * to create them; the loser's insert is expected to fail and is ignored. A
   * failing membership upsert is not ignored, because that is the row deciding
   * what the caller is allowed to do.
   */
  private async provisionMember(member: {
    tenantId: string;
    userId: string;
    role: string;
    email: string;
  }): Promise<void> {
    const { store, clock, logger } = this.services;
    if (!(await store.tenants.get(member.tenantId))) {
      await store.tenants
        .create({
          id: member.tenantId,
          name: member.tenantId,
          status: "ACTIVE",
          createdAt: clock.now(),
        })
        .catch(() => undefined);
    }
    if (!(await store.users.get(member.tenantId, member.userId))) {
      await store.users
        .create({
          id: member.userId,
          tenantId: member.tenantId,
          externalIdentity: `${member.tenantId}:${member.userId}`,
          email: member.email,
          status: "ACTIVE",
          createdAt: clock.now(),
        })
        .catch(() => undefined);
    }
    await store.memberships
      .upsert({
        tenantId: member.tenantId,
        userId: member.userId,
        role: member.role,
        createdAt: clock.now(),
      })
      .catch((error: unknown) => {
        logger.error("Could not record a workspace membership", {
          tenantId: member.tenantId,
          userId: member.userId,
          error: clampText((error as Error).message, 200),
        });
      });
  }

  /**
   * Downstream authentication. A gateway API key is the simplest credential and
   * is checked first; where the operator has configured authorization servers
   * the same header may instead carry an access token those servers minted for
   * this gateway. Neither path changes anything upstream: the caller's identity
   * only decides which tenant's connections and grants are in scope.
   */
  async authenticate(req: IncomingMessage): Promise<AuthenticationOutcome> {
    const presented = extractBearer(req);
    if (!presented) return { authenticated: false };

    const match = this.services.config.apiKeys.find((candidate) =>
      constantTimeEquals(candidate.key, presented),
    );
    if (match) {
      return {
        authenticated: true,
        principal: await this.principalFor(
          match.tenantId,
          match.userId,
          match.label,
          match.role,
        ),
      };
    }

    if (!this.services.resourceServer.enabled) return { authenticated: false };
    try {
      const token = await this.services.resourceServer.verify(presented);
      return { authenticated: true, principal: await this.principalForToken(token) };
    } catch (error) {
      return { authenticated: false, challenge: toChallenge(error) };
    }
  }

  /** The principal for an already-authenticated caller. */
  private async principalFor(
    tenantId: string,
    userId: string,
    clientLabel: string,
    fallbackRole: string,
  ): Promise<NorthboundPrincipal> {
    // The membership is the authority, so a role changed in the database takes
    // effect without restarting the process.
    const membership = await this.services.store.memberships.get(tenantId, userId);
    return {
      tenantId,
      userId,
      clientLabel,
      roles: [membership?.role ?? fallbackRole],
    };
  }

  /**
   * Maps a verified access token onto a workspace member, creating the tenant,
   * user and membership the first time a subject appears. Without that the
   * operator would have to pre-create a row for everyone their authorization
   * server can already vouch for.
   */
  private async principalForToken(
    token: VerifiedAccessToken,
  ): Promise<NorthboundPrincipal> {
    const { config } = this.services;
    const claim = token.claims[config.tenantClaim];
    const tenantId =
      typeof claim === "string" && claim !== "" ? claim : config.defaultTenantId;
    if (!tenantId) {
      throw new GatewayError(
        "FORBIDDEN",
        `Token carries no ${config.tenantClaim} claim and no default tenant is configured`,
      );
    }
    const userId = `${issuerKey(token.issuer)}:${token.subject}`;
    const role = roleFromClaims(token.claims, config.rolesClaim) ?? config.defaultRole;
    const email = token.claims["email"];

    await this.provisionMember({
      tenantId,
      userId,
      role,
      email: typeof email === "string" ? email : `${userId}@example.invalid`,
    });

    return {
      tenantId,
      userId,
      clientLabel: token.clientId ?? "oauth",
      roles: [role],
    };
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.services.config.baseUrl);
    const resolved = this.router.resolve(req.method ?? "GET", url);
    if (!resolved) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      await resolved.handler(req, res, resolved.match);
    } catch (error) {
      const gatewayError = toGatewayError(error);
      this.services.logger.error("Unhandled gateway error", {
        path: url.pathname,
        code: gatewayError.code,
        message: gatewayError.message,
      });
      if (!res.headersSent) {
        res.writeHead(gatewayError.httpStatus, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: gatewayError.code.toLowerCase(),
            message: gatewayError.message,
            data: gatewayError.data ?? null,
          }),
        );
      } else {
        res.end();
      }
    }
  }

  async listen(port?: number): Promise<number> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(port ?? this.services.config.port, this.services.config.host, resolve);
    });
    const address = server.address() as AddressInfo;
    this.services.logger.info("Gateway listening", { port: address.port });
    return address.port;
  }

  async close(): Promise<void> {
    await this.services.northbound.closeAll();
    await this.services.upstreamSessions.closeAll();
    if (this.server) {
      const server = this.server;
      this.server = null;
      // Event streams hold keep-alive sockets open; drop them so shutdown does
      // not wait for idle clients to disconnect on their own.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.services.store.close();
  }
}

/** Turns a verification failure into the challenge the client should see. */
function toChallenge(error: unknown): BearerChallenge {
  const gatewayError = toGatewayError(error);
  const data = isRecord(gatewayError.data) ? gatewayError.data : {};
  const oauthError = data["oauthError"];
  const scope = data["scope"];
  return {
    error:
      oauthError === "insufficient_scope" || oauthError === "invalid_request"
        ? oauthError
        : "invalid_token",
    description: gatewayError.message,
    status: gatewayError.httpStatus === 403 ? 403 : 401,
    ...(typeof scope === "string" ? { scope } : {}),
  };
}

/**
 * Namespaces a subject by its issuer. Two authorization servers may both mint
 * `sub: "1"`, and without the prefix the second one silently inherits the
 * first's connections.
 */
function issuerKey(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

function roleFromClaims(claims: Record<string, unknown>, claim: string): string | null {
  const value = claims[claim];
  if (typeof value === "string" && value !== "") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string" && entry !== "");
    if (typeof first === "string") return first;
  }
  return null;
}

export function extractBearer(req: IncomingMessage): string | null {
  const authorization = headerValue(req, "authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const apiKey = headerValue(req, "x-gateway-key");
  return apiKey ?? null;
}

export function parseJsonBody(raw: string): Record<string, unknown> {
  const parsed = safeJsonParse(raw);
  if (!isRecord(parsed)) {
    throw new GatewayError("INVALID_REQUEST", "Expected a JSON object body");
  }
  return parsed;
}

export function newRequestId(): string {
  return newId("req");
}

export type { ApiKeyPrincipal, GatewayConfig };
