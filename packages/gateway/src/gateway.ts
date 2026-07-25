import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  GatewayError,
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
  type NorthboundPrincipal,
} from "@umg/mcp-server";
import {
  DEFAULT_TOKEN_MANAGER_CONFIG,
  OAuthDiscoveryService,
  OAuthTokenClient,
  OAuthTokenManager,
  RegistrationSelector,
  buildClientIdMetadataDocument,
  gatewayIdentityFromBaseUrl,
  type GatewayIdentity,
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
    const { store, clock, config } = this.services;
    for (const principal of config.apiKeys) {
      const tenant = await store.tenants.get(principal.tenantId);
      if (!tenant) {
        await store.tenants
          .create({
            id: principal.tenantId,
            name: principal.tenantId,
            status: "ACTIVE",
            createdAt: clock.now(),
          })
          .catch(() => undefined);
      }
      const user = await store.users.get(principal.tenantId, principal.userId);
      if (!user) {
        await store.users
          .create({
            id: principal.userId,
            tenantId: principal.tenantId,
            externalIdentity: `${principal.tenantId}:${principal.userId}`,
            email: `${principal.userId}@example.invalid`,
            status: "ACTIVE",
            createdAt: clock.now(),
          })
          .catch(() => undefined);
      }
      await store.memberships
        .upsert({
          tenantId: principal.tenantId,
          userId: principal.userId,
          role: principal.role,
          createdAt: clock.now(),
        })
        .catch(() => undefined);
    }
  }

  /**
   * Downstream authentication. The MVP accepts a gateway API key; production
   * deployments front this with an OAuth authorization server and validate the
   * bearer token against it, which changes nothing upstream.
   */
  async authenticate(req: IncomingMessage): Promise<NorthboundPrincipal | null> {
    const presented = extractBearer(req);
    if (!presented) return null;
    const match = this.services.config.apiKeys.find((candidate) =>
      constantTimeEquals(candidate.key, presented),
    );
    if (!match) return null;
    // The membership is the authority, so a role changed in the database takes
    // effect without restarting the process.
    const membership = await this.services.store.memberships.get(
      match.tenantId,
      match.userId,
    );
    return {
      tenantId: match.tenantId,
      userId: match.userId,
      clientLabel: match.label,
      roles: [membership?.role ?? match.role],
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
