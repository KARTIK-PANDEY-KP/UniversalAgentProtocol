import {
  GatewayError,
  newId,
  type Clock,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpImplementation,
  type UpstreamConnection,
} from "@umg/core";
import { UpstreamMcpConnection } from "@umg/mcp-client";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import type { CredentialVault, SafeFetcher } from "@umg/security";
import type { GatewayStore } from "@umg/storage";
import type { OAuthTokenManager } from "@umg/oauth";

/** Session key used for gateway-internal work such as catalogue discovery. */
export const CATALOGUE_SESSION = "__catalogue__";

export interface UpstreamMessageContext {
  connectionId: string;
  alias: string;
  tenantId: string;
  downstreamSessionId: string;
}

export interface UpstreamSessionDeps {
  store: GatewayStore;
  vault: CredentialVault;
  tokenManager: OAuthTokenManager;
  fetcher: SafeFetcher;
  logger: Logger;
  metrics: MetricsRegistry;
  clock: Clock;
  clientInfo: McpImplementation;
  clientCapabilities: McpClientCapabilities;
  requestTimeoutMs?: number;
  onNotification?(
    context: UpstreamMessageContext,
    notification: JsonRpcNotification,
  ): void;
  onServerRequest?(
    context: UpstreamMessageContext,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse>;
}

interface Entry {
  connection: UpstreamMcpConnection;
  lastUsed: number;
}

/**
 * Owns the live MCP client sessions towards upstream servers. The default
 * policy is one upstream session per downstream session so that per-session
 * state on the upstream cannot leak between two AI applications, even though
 * both resolve to the same OAuth grant.
 */
export class UpstreamSessionManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: UpstreamSessionDeps) {}

  /** Live upstream sessions, for health reporting and the reaper's tests. */
  get size(): number {
    return this.entries.size;
  }

  private key(connectionId: string, downstreamSessionId: string): string {
    return `${connectionId}::${downstreamSessionId}`;
  }

  async acquire(
    connection: UpstreamConnection,
    downstreamSessionId: string,
  ): Promise<UpstreamMcpConnection> {
    const key = this.key(connection.id, downstreamSessionId);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = this.deps.clock.now();
      return existing.connection;
    }

    const server = await this.deps.store.mcpServers.get(
      connection.tenantId,
      connection.mcpServerId,
    );
    if (!server) {
      throw new GatewayError("NOT_FOUND", "MCP server record is missing");
    }

    const context: UpstreamMessageContext = {
      connectionId: connection.id,
      alias: connection.alias,
      tenantId: connection.tenantId,
      downstreamSessionId,
    };

    const client = new UpstreamMcpConnection({
      url: server.canonicalUrl,
      fetcher: this.deps.fetcher,
      logger: this.deps.logger.child({ connectionId: connection.id }),
      metrics: this.deps.metrics,
      authHeaders: (request) =>
        this.deps.tokenManager.authorizationHeaders(
          { tenantId: connection.tenantId, connectionId: connection.id },
          request,
        ),
      onDpopNonce: (nonce) =>
        this.deps.tokenManager.rememberResourceNonce(connection.id, nonce),
      clientInfo: this.deps.clientInfo,
      clientCapabilities: this.deps.clientCapabilities,
      transportKind: server.transportType === "HTTP_SSE" ? "HTTP_SSE" : "STREAMABLE_HTTP",
      ...(this.deps.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.deps.requestTimeoutMs }),
      hooks: {
        onNotification: (notification) => {
          this.deps.onNotification?.(context, notification);
        },
        ...(this.deps.onServerRequest
          ? {
              onServerRequest: (request: JsonRpcRequest) =>
                this.deps.onServerRequest!(context, request),
            }
          : {}),
      },
    });

    try {
      await client.initialize();
    } catch (error) {
      this.deps.metrics.counter(Metric.McpUpstreamInitializationFailed, {
        alias: connection.alias,
      });
      await client.close().catch(() => undefined);
      throw error;
    }

    await this.persist(connection, downstreamSessionId, client);
    this.entries.set(key, { connection: client, lastUsed: this.deps.clock.now() });
    return client;
  }

  private async persist(
    connection: UpstreamConnection,
    downstreamSessionId: string,
    client: UpstreamMcpConnection,
  ): Promise<void> {
    const sessionId = client.sessionId;
    await this.deps.store.upstreamSessions.upsert({
      id: newId("usess"),
      tenantId: connection.tenantId,
      connectionId: connection.id,
      downstreamSessionId,
      upstreamSessionIdEncrypted: sessionId
        ? await this.deps.vault.encrypt(
            { tenantId: connection.tenantId, purpose: "upstream_session_id" },
            sessionId,
          )
        : null,
      protocolVersion: client.protocolVersion ?? "unknown",
      capabilitiesJson: client.capabilities as Record<string, never>,
      status: "ACTIVE",
      createdAt: this.deps.clock.now(),
      lastSeenAt: this.deps.clock.now(),
    });
  }

  async release(connectionId: string, downstreamSessionId: string): Promise<void> {
    const key = this.key(connectionId, downstreamSessionId);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.connection.close().catch(() => undefined);
  }

  async releaseDownstream(downstreamSessionId: string): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (!key.endsWith(`::${downstreamSessionId}`)) continue;
      this.entries.delete(key);
      await entry.connection.close().catch(() => undefined);
    }
    await this.deps.store.upstreamSessions.closeByDownstream(downstreamSessionId);
  }

  async releaseConnection(connectionId: string): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(`${connectionId}::`)) continue;
      this.entries.delete(key);
      await entry.connection.close().catch(() => undefined);
    }
    await this.deps.store.upstreamSessions.closeByConnection(connectionId);
  }

  async closeAll(): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      this.entries.delete(key);
      await entry.connection.close().catch(() => undefined);
    }
  }

  /** Closes upstream sessions that have been idle beyond the window. */
  async sweep(idleMs: number): Promise<number> {
    const now = this.deps.clock.now();
    let closed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.lastUsed <= idleMs) continue;
      this.entries.delete(key);
      await entry.connection.close().catch(() => undefined);
      closed += 1;
    }
    return closed;
  }
}
