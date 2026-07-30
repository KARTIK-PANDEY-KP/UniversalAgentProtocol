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
} from "@uap/core";
import { UpstreamMcpConnection } from "@uap/mcp-client";
import { Metric, type Logger, type MetricsRegistry } from "@uap/observability";
import type { CredentialVault, SafeFetcher } from "@uap/security";
import type { GatewayStore } from "@uap/storage";
import type { OAuthTokenManager } from "@uap/oauth";

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
 * An open in progress. The token identifies this particular attempt, so an
 * attempt that was released while it was still connecting can tell that the
 * session it just built is no longer wanted.
 */
interface Opening {
  token: object;
  promise: Promise<UpstreamMcpConnection>;
}

/**
 * Owns the live MCP client sessions towards upstream servers. The default
 * policy is one upstream session per downstream session so that per-session
 * state on the upstream cannot leak between two AI applications, even though
 * both resolve to the same OAuth grant.
 */
export class UpstreamSessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly openings = new Map<string, Opening>();

  constructor(private readonly deps: UpstreamSessionDeps) {}

  /** Live upstream sessions, for health reporting and the reaper's tests. */
  get size(): number {
    return this.entries.size;
  }

  private key(connectionId: string, downstreamSessionId: string): string {
    return `${connectionId}::${downstreamSessionId}`;
  }

  /** The live upstream clients a downstream session is talking through. */
  forDownstream(downstreamSessionId: string): UpstreamMcpConnection[] {
    const suffix = `::${downstreamSessionId}`;
    return [...this.entries]
      .filter(([key]) => key.endsWith(suffix))
      .map(([, entry]) => entry.connection);
  }

  /**
   * One live session per downstream session, even when several requests arrive
   * before the first one has finished connecting. Without the shared attempt,
   * each caller initializes its own upstream session and all but the last are
   * dropped on the floor still open.
   */
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

    const opening = this.openings.get(key);
    if (opening) return opening.promise;

    const token = {};
    const promise = this.open(connection, downstreamSessionId, key, token).finally(() => {
      if (this.openings.get(key)?.token === token) this.openings.delete(key);
    });
    this.openings.set(key, { token, promise });
    return promise;
  }

  private async open(
    connection: UpstreamConnection,
    downstreamSessionId: string,
    key: string,
    token: object,
  ): Promise<UpstreamMcpConnection> {
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

    // A release that arrived while this was connecting dropped our token. The
    // session it was asked to tear down is the one that just finished opening,
    // so it is closed here rather than being recorded as live.
    if (this.openings.get(key)?.token !== token) {
      await client.close().catch(() => undefined);
      throw new GatewayError("CONFLICT", "Upstream session was released while connecting", {
        retryable: true,
      });
    }

    await this.persist(connection, downstreamSessionId, client);
    this.entries.set(key, { connection: client, lastUsed: this.deps.clock.now() });
    return client;
  }

  /**
   * Marks an attempt as unwanted. It cannot be aborted mid-flight, so instead
   * its token is dropped and `open` closes the session it produces.
   */
  private cancelOpening(key: string): void {
    const opening = this.openings.get(key);
    if (!opening) return;
    this.openings.delete(key);
    opening.promise.catch(() => undefined);
  }

  private async persist(
    connection: UpstreamConnection,
    downstreamSessionId: string,
    client: UpstreamMcpConnection,
  ): Promise<void> {
    await this.deps.store.upstreamSessions.upsert({
      id: newId("usess"),
      tenantId: connection.tenantId,
      connectionId: connection.id,
      downstreamSessionId,
      protocolVersion: client.protocolVersion ?? "unknown",
      capabilitiesJson: client.capabilities as Record<string, never>,
      status: "ACTIVE",
      createdAt: this.deps.clock.now(),
      lastSeenAt: this.deps.clock.now(),
    });
  }

  async release(connectionId: string, downstreamSessionId: string): Promise<void> {
    const key = this.key(connectionId, downstreamSessionId);
    this.cancelOpening(key);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.connection.close().catch(() => undefined);
  }

  async releaseDownstream(downstreamSessionId: string): Promise<void> {
    const suffix = `::${downstreamSessionId}`;
    for (const key of [...this.openings.keys()]) {
      if (key.endsWith(suffix)) this.cancelOpening(key);
    }
    for (const [key, entry] of [...this.entries]) {
      if (!key.endsWith(suffix)) continue;
      this.entries.delete(key);
      await entry.connection.close().catch(() => undefined);
    }
    await this.deps.store.upstreamSessions.closeByDownstream(downstreamSessionId);
  }

  async releaseConnection(connectionId: string): Promise<void> {
    const prefix = `${connectionId}::`;
    for (const key of [...this.openings.keys()]) {
      if (key.startsWith(prefix)) this.cancelOpening(key);
    }
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      await entry.connection.close().catch(() => undefined);
    }
    await this.deps.store.upstreamSessions.closeByConnection(connectionId);
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.openings.keys()]) this.cancelOpening(key);
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
