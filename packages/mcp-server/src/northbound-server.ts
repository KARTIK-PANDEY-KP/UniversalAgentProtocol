import type { IncomingMessage, ServerResponse } from "node:http";

import {
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_HEADER,
  McpMethod,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  jsonRpcFailure,
  jsonRpcSuccess,
  negotiateProtocolVersion,
  safeJsonParse,
  toGatewayError,
  type Clock,
  type JsonObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpImplementation,
  type McpInitializeParams,
  type McpInitializeResult,
} from "@umg/core";
import type { Logger, MetricsRegistry } from "@umg/observability";
import { isOriginAllowed } from "@umg/security";

import {
  headerValue,
  openEventStream,
  readBody,
  sendEmpty,
  sendJson,
  type EventStreamWriter,
} from "./http.js";
import { DownstreamSession, type DownstreamSessionHandle } from "./session.js";

export interface NorthboundPrincipal {
  tenantId: string;
  userId: string;
  clientLabel: string;
}

export type NorthboundAuthenticator = (
  req: IncomingMessage,
) => Promise<NorthboundPrincipal | null>;

export interface RequestContext {
  sendNotification(notification: JsonRpcNotification): void;
  signal: AbortSignal;
}

export interface McpServerHandler {
  onInitialize(
    params: McpInitializeParams,
    session: DownstreamSessionHandle,
  ): Promise<McpInitializeResult>;
  onRequest(
    request: JsonRpcRequest,
    session: DownstreamSessionHandle,
    context: RequestContext,
  ): Promise<JsonObject>;
  onNotification(
    notification: JsonRpcNotification,
    session: DownstreamSessionHandle,
  ): Promise<void>;
  onSessionClosed(session: DownstreamSessionHandle): Promise<void>;
}

export interface NorthboundServerOptions {
  handler: McpServerHandler;
  authenticate: NorthboundAuthenticator;
  allowedOrigins: string[];
  logger: Logger;
  metrics: MetricsRegistry;
  clock: Clock;
  serverInfo: McpImplementation;
  instructions?: string;
  /** Advertised in the 401 challenge so clients can discover how to log in. */
  resourceMetadataUrl?: string;
  maxBodyBytes?: number;
  sessionIdleMs?: number;
}

/** Methods whose responses may be preceded by progress notifications. */
const STREAMING_METHODS = new Set<string>([
  McpMethod.ToolsCall,
  McpMethod.ResourcesRead,
  McpMethod.PromptsGet,
  McpMethod.CompletionComplete,
]);

/**
 * Streamable HTTP server for downstream MCP clients. Each connected client
 * gets its own session even though several sessions may resolve to the same
 * upstream OAuth grants.
 */
export class NorthboundMcpServer {
  private readonly sessions = new Map<string, DownstreamSession>();

  constructor(private readonly options: NorthboundServerOptions) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  getSession(id: string): DownstreamSession | undefined {
    return this.sessions.get(id);
  }

  /** All live sessions belonging to a tenant, used to fan out list changes. */
  sessionsForTenant(tenantId: string): DownstreamSession[] {
    return [...this.sessions.values()].filter(
      (session) => session.tenantId === tenantId && !session.isClosed,
    );
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isOriginAllowed(headerValue(req, "origin"), this.options.allowedOrigins)) {
      sendJson(res, 403, { error: "origin_not_allowed" });
      return;
    }

    const principal = await this.options.authenticate(req);
    if (!principal) {
      const headers: Record<string, string> = {};
      if (this.options.resourceMetadataUrl) {
        headers["www-authenticate"] =
          `Bearer resource_metadata="${this.options.resourceMetadataUrl}"`;
      }
      sendJson(res, 401, { error: "unauthorized" }, headers);
      return;
    }

    switch (req.method) {
      case "POST":
        await this.handlePost(req, res, principal);
        return;
      case "GET":
        await this.handleGet(req, res, principal);
        return;
      case "DELETE":
        await this.handleDelete(req, res, principal);
        return;
      default:
        sendEmpty(res, 405, { allow: "GET, POST, DELETE" });
    }
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close();
      await this.options.handler.onSessionClosed(session);
    }
    this.sessions.clear();
  }

  /** Drops sessions that have not been seen within the idle window. */
  /** Closes sessions untouched for longer than `idleMs`. */
  async sweep(now: number, idleMs = this.options.sessionIdleMs ?? 30 * 60_000): Promise<number> {
    let removed = 0;
    for (const [id, session] of [...this.sessions]) {
      if (now - session.lastSeenAt <= idleMs) continue;
      session.close();
      this.sessions.delete(id);
      await this.options.handler.onSessionClosed(session);
      removed += 1;
    }
    return removed;
  }

  private async handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    principal: NorthboundPrincipal,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, this.options.maxBodyBytes ?? 4_000_000);
    } catch (error) {
      const gatewayError = toGatewayError(error);
      sendJson(res, gatewayError.httpStatus, { error: gatewayError.code });
      return;
    }

    const parsed = safeJsonParse(raw);
    if (parsed === undefined) {
      sendJson(
        res,
        400,
        jsonRpcFailure(null, JsonRpcErrorCode.ParseError, "Invalid JSON"),
      );
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0) {
      sendJson(
        res,
        400,
        jsonRpcFailure(null, JsonRpcErrorCode.InvalidRequest, "Empty batch"),
      );
      return;
    }

    const initializeRequest = messages.find(
      (message) => isJsonRpcRequest(message) && message.method === McpMethod.Initialize,
    );
    if (initializeRequest) {
      await this.handleInitialize(initializeRequest as JsonRpcRequest, res, principal);
      return;
    }

    const session = this.resolveSession(req, principal);
    if (!session) {
      sendJson(
        res,
        404,
        jsonRpcFailure(
          null,
          JsonRpcErrorCode.InvalidRequest,
          "Unknown or expired MCP session",
        ),
      );
      return;
    }
    session.lastSeenAt = this.options.clock.now();

    const versionHeader = headerValue(req, MCP_PROTOCOL_VERSION_HEADER);
    if (versionHeader && versionHeader !== session.protocolVersion) {
      sendJson(
        res,
        400,
        jsonRpcFailure(
          null,
          JsonRpcErrorCode.InvalidRequest,
          `Unsupported MCP-Protocol-Version: ${versionHeader}`,
        ),
      );
      return;
    }

    // Responses to server-initiated requests and plain notifications are
    // acknowledged without a body.
    const requests = messages.filter(isJsonRpcRequest);
    for (const message of messages) {
      if (isJsonRpcResponse(message)) session.resolveResponse(message);
      else if (isJsonRpcNotification(message)) {
        await this.options.handler
          .onNotification(message, session)
          .catch((error: unknown) => {
            this.options.logger.warn("Notification handler failed", {
              method: message.method,
              error: (error as Error).message,
            });
          });
      }
    }
    if (requests.length === 0) {
      sendEmpty(res, 202);
      return;
    }

    const accept = headerValue(req, "accept") ?? "";
    const wantsStream =
      accept.includes("text/event-stream") &&
      requests.some((request) => STREAMING_METHODS.has(request.method));

    if (wantsStream) {
      await this.respondViaStream(res, session, requests);
      return;
    }

    const responses: JsonRpcResponse[] = [];
    for (const request of requests) {
      responses.push(await this.execute(request, session));
    }
    sendJson(res, 200, responses.length === 1 ? responses[0] : responses);
  }

  private async respondViaStream(
    res: ServerResponse,
    session: DownstreamSession,
    requests: JsonRpcRequest[],
  ): Promise<void> {
    const stream = openEventStream(res, {
      [MCP_SESSION_HEADER]: session.id,
    });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      for (const request of requests) {
        const response = await this.execute(request, session, {
          sendNotification: (notification) => stream.write(notification),
          signal: controller.signal,
        });
        stream.write(response);
      }
    } finally {
      stream.end();
    }
  }

  private async execute(
    request: JsonRpcRequest,
    session: DownstreamSession,
    context?: RequestContext,
  ): Promise<JsonRpcResponse> {
    const effective: RequestContext = context ?? {
      sendNotification: (notification) => session.sendNotification(notification),
      signal: new AbortController().signal,
    };
    try {
      const result = await this.options.handler.onRequest(request, session, effective);
      return jsonRpcSuccess(request.id, result);
    } catch (error) {
      const gatewayError = toGatewayError(error);
      this.options.logger.warn("Downstream request failed", {
        method: request.method,
        code: gatewayError.code,
        tenantId: session.tenantId,
        sessionId: session.id,
      });
      return jsonRpcFailure(
        request.id,
        gatewayError.toJsonRpcCode(),
        gatewayError.message,
        gatewayError.data ?? null,
      );
    }
  }

  private async handleInitialize(
    request: JsonRpcRequest,
    res: ServerResponse,
    principal: NorthboundPrincipal,
  ): Promise<void> {
    const params = (request.params ?? {}) as unknown as McpInitializeParams;
    const protocolVersion = negotiateProtocolVersion(
      params.protocolVersion ?? LATEST_PROTOCOL_VERSION,
    );
    const session = new DownstreamSession(
      principal.tenantId,
      principal.userId,
      params.clientInfo?.name
        ? `${params.clientInfo.name}/${params.clientInfo.version}`
        : principal.clientLabel,
      protocolVersion,
      this.options.clock.now(),
    );
    session.capabilities = (params.capabilities ?? {}) as McpClientCapabilities;
    this.sessions.set(session.id, session);

    try {
      const result = await this.options.handler.onInitialize(params, session);
      sendJson(res, 200, jsonRpcSuccess(request.id, result as unknown as JsonObject), {
        [MCP_SESSION_HEADER]: session.id,
      });
    } catch (error) {
      this.sessions.delete(session.id);
      const gatewayError = toGatewayError(error);
      sendJson(
        res,
        200,
        jsonRpcFailure(
          request.id,
          gatewayError.toJsonRpcCode(),
          gatewayError.message,
          gatewayError.data ?? null,
        ),
      );
    }
  }

  private async handleGet(
    req: IncomingMessage,
    res: ServerResponse,
    principal: NorthboundPrincipal,
  ): Promise<void> {
    const accept = headerValue(req, "accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      sendEmpty(res, 405, { allow: "POST, DELETE" });
      return;
    }
    const session = this.resolveSession(req, principal);
    if (!session) {
      sendJson(res, 404, { error: "unknown_session" });
      return;
    }
    session.lastSeenAt = this.options.clock.now();
    const stream: EventStreamWriter = openEventStream(res, {
      [MCP_SESSION_HEADER]: session.id,
    });
    session.attachStream(stream);
    const keepAlive = setInterval(() => stream.comment("keep-alive"), 25_000);
    keepAlive.unref?.();
    res.on("close", () => {
      clearInterval(keepAlive);
      session.detachStream(stream);
    });
  }

  private async handleDelete(
    req: IncomingMessage,
    res: ServerResponse,
    principal: NorthboundPrincipal,
  ): Promise<void> {
    const session = this.resolveSession(req, principal);
    if (!session) {
      sendEmpty(res, 404);
      return;
    }
    this.sessions.delete(session.id);
    session.close();
    await this.options.handler.onSessionClosed(session);
    sendEmpty(res, 204);
  }

  private resolveSession(
    req: IncomingMessage,
    principal: NorthboundPrincipal,
  ): DownstreamSession | undefined {
    const id = headerValue(req, MCP_SESSION_HEADER);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session || session.isClosed) return undefined;
    // A session id from another tenant or user must never be usable.
    if (session.tenantId !== principal.tenantId || session.userId !== principal.userId) {
      this.options.logger.warn("Rejected cross-principal MCP session reuse", {
        sessionId: id,
        tenantId: principal.tenantId,
      });
      return undefined;
    }
    return session;
  }
}