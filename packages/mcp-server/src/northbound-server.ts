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
  isRecord,
  isRequestId,
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
  /** Workspace roles, which decide which tools the caller may invoke. */
  roles: string[];
}

/**
 * Why a credential was turned away, in the vocabulary of RFC 6750 so it can be
 * echoed straight into a `WWW-Authenticate` challenge. A client that is told
 * only "unauthorized" cannot tell a expired token from a missing scope, and so
 * retries the wrong recovery.
 */
export interface BearerChallenge {
  error: "invalid_token" | "insufficient_scope" | "invalid_request";
  description: string;
  status: number;
  /** Scopes the caller would need, for an `insufficient_scope` challenge. */
  scope?: string;
}

export type AuthenticationOutcome =
  | { authenticated: true; principal: NorthboundPrincipal }
  /** No usable credential: `challenge` is absent when none was presented. */
  | { authenticated: false; challenge?: BearerChallenge };

export type NorthboundAuthenticator = (
  req: IncomingMessage,
) => Promise<AuthenticationOutcome>;

/** Assembles the `WWW-Authenticate` value for a rejected or absent credential. */
export function bearerChallengeHeader(
  resourceMetadataUrl: string | undefined,
  challenge: BearerChallenge | undefined,
): string {
  const parts: string[] = [];
  if (challenge) {
    parts.push(`error="${challenge.error}"`);
    parts.push(`error_description="${challenge.description.replaceAll('"', "'")}"`);
    if (challenge.scope) parts.push(`scope="${challenge.scope}"`);
  }
  if (resourceMetadataUrl) parts.push(`resource_metadata="${resourceMetadataUrl}"`);
  return parts.length === 0 ? "Bearer" : `Bearer ${parts.join(", ")}`;
}

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

/** The `Last-Event-ID` of a reconnecting client, if it sent a usable one. */
function parseEventId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Methods whose responses may be preceded by progress notifications. */
const STREAMING_METHODS = new Set<string>([
  McpMethod.ToolsCall,
  McpMethod.ResourcesRead,
  McpMethod.PromptsGet,
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

    const outcome = await this.options.authenticate(req);
    if (!outcome.authenticated) {
      const { challenge } = outcome;
      sendJson(
        res,
        challenge?.status ?? 401,
        {
          error: challenge?.error ?? "unauthorized",
          ...(challenge ? { error_description: challenge.description } : {}),
        },
        {
          "www-authenticate": bearerChallengeHeader(
            this.options.resourceMetadataUrl,
            challenge,
          ),
        },
      );
      return;
    }
    const principal = outcome.principal;

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

    // Anything that is not a request, a notification or a response would be
    // dropped by the loop below, and the client would read the 202 that
    // followed as an acknowledgement of work nobody is going to do.
    const malformed = messages.find(
      (message) =>
        !isJsonRpcRequest(message) &&
        !isJsonRpcNotification(message) &&
        !isJsonRpcResponse(message),
    );
    if (malformed !== undefined) {
      const id = isRecord(malformed) && isRequestId(malformed["id"]) ? malformed["id"] : null;
      sendJson(
        res,
        400,
        jsonRpcFailure(
          id,
          JsonRpcErrorCode.InvalidRequest,
          "Not a JSON-RPC 2.0 request, notification or response",
        ),
      );
      return;
    }

    const initializeRequest = messages.find(
      (message) => isJsonRpcRequest(message) && message.method === McpMethod.Initialize,
    );
    if (initializeRequest) {
      // Initialization establishes the session everything else is answered
      // within, so it cannot share a batch: silently dropping the rest would
      // lose work the client believes it submitted.
      if (messages.length > 1) {
        sendJson(
          res,
          400,
          jsonRpcFailure(
            (initializeRequest as JsonRpcRequest).id,
            JsonRpcErrorCode.InvalidRequest,
            "initialize must be sent on its own, not batched with other messages",
          ),
        );
        return;
      }
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
        if (message.method === McpMethod.Cancelled) this.cancel(message, session);
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

  /**
   * Aborts the request a `notifications/cancelled` names. The abort propagates
   * to the upstream call, which sends its own cancellation onward, so work
   * stops at the far end rather than merely being abandoned here.
   */
  private cancel(notification: JsonRpcNotification, session: DownstreamSession): void {
    const requestId = notification.params?.["requestId"];
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const cancelled = session.cancelRequest(requestId);
    this.options.logger.debug("Downstream cancellation", {
      sessionId: session.id,
      requestId,
      // A cancellation that arrives after the response is not an error; the
      // client simply could not know it was already too late.
      cancelled,
    });
  }

  private async respondViaStream(
    res: ServerResponse,
    session: DownstreamSession,
    requests: JsonRpcRequest[],
  ): Promise<void> {
    const stream = openEventStream(res, {
      [MCP_SESSION_HEADER]: session.id,
    });
    const disconnected = new AbortController();
    res.on("close", () => disconnected.abort());
    // A server-to-client request raised while these run belongs on this
    // stream, which for most clients is the only one they ever open.
    session.beginRequestStream(stream);
    try {
      for (const request of requests) {
        const response = await this.execute(request, session, {
          sendNotification: (notification) => stream.write(notification),
          signal: disconnected.signal,
        });
        stream.write(response);
      }
    } finally {
      session.endRequestStream(stream);
      stream.end();
    }
  }

  /**
   * Runs one request under a controller the client can abort by id. The
   * enclosing signal, when there is one, aborts it too: a client that hangs up
   * mid-stream has cancelled everything it was waiting for.
   */
  private async execute(
    request: JsonRpcRequest,
    session: DownstreamSession,
    context?: RequestContext,
  ): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    context?.signal.addEventListener("abort", abort, { once: true });
    session.beginRequest(request.id, controller);

    const effective: RequestContext = {
      sendNotification:
        context?.sendNotification ??
        ((notification) => session.sendNotification(notification)),
      signal: controller.signal,
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
    } finally {
      session.endRequest(request.id);
      context?.signal.removeEventListener("abort", abort);
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
      principal.roles,
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
    session.attachStream(stream, parseEventId(headerValue(req, "last-event-id")));
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