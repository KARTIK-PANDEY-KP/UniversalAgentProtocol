import {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_HEADER,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  safeJsonParse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type UpstreamRequestTarget,
} from "@umg/core";
import type { Logger } from "@umg/observability";
import type { SafeFetcher, SafeResponse } from "@umg/security";

import { readSseEvents } from "./sse.js";
import {
  McpProtocolError,
  McpSessionExpiredError,
  McpUnauthorizedError,
  type McpTransport,
  type SendOptions,
  type TransportHooks,
} from "./transport.js";

export interface StreamableHttpOptions {
  url: string;
  fetcher: SafeFetcher;
  logger: Logger;
  hooks: TransportHooks;
  /** Resolved per request so a refreshed access token is picked up promptly. */
  authHeaders: (request: UpstreamRequestTarget) => Promise<Record<string, string>>;
  /** Called when the upstream demands a DPoP nonce, before the retry. */
  onDpopNonce?: (nonce: string) => void;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * How a server words its refusal of a session id it does not hold. Only ever
 * consulted for a 400 that would otherwise be reported as a protocol error, so
 * failing to match costs the accuracy of one message rather than correctness.
 */
const FORGOTTEN_SESSION =
  /not initialized|session (?:not found|expired|is invalid)|invalid session|unknown session/i;

/**
 * Client side of the MCP Streamable HTTP transport. A POST either returns a
 * single JSON response or an event stream that carries progress notifications
 * and server-initiated requests before the final response.
 */
export class StreamableHttpTransport implements McpTransport {
  readonly kind = "STREAMABLE_HTTP" as const;

  protocolVersion: string | null = null;
  private session: string | null = null;
  private serverStream: AbortController | null = null;
  private closed = false;
  /** Every request still on the wire, so closing does not leave one hanging. */
  private readonly inFlight = new Set<AbortController>();
  /** Last event id the server stream delivered, for resuming after a drop. */
  private lastServerEventId: string | null = null;
  private serverStreamAttempt = 0;

  constructor(private readonly options: StreamableHttpOptions) {}

  get sessionId(): string | null {
    return this.session;
  }

  setSessionId(value: string | null): void {
    this.session = value;
  }

  async send(
    request: JsonRpcRequest,
    options: SendOptions = {},
  ): Promise<JsonRpcResponse> {
    const response = await this.post(request, options);
    const contentType = response.contentType ?? "";

    if (contentType.startsWith(JSON_CONTENT_TYPE)) {
      const payload = safeJsonParse(await response.text());
      if (Array.isArray(payload)) {
        const match = payload.find(
          (item) => isJsonRpcResponse(item) && item.id === request.id,
        );
        if (match) return match as JsonRpcResponse;
      }
      if (isJsonRpcResponse(payload)) return payload;
      throw new McpProtocolError("Upstream returned a malformed JSON-RPC response");
    }

    if (contentType.startsWith(SSE_CONTENT_TYPE)) {
      return this.readResponseFromStream(response, request);
    }

    response.discard();
    throw new McpProtocolError(
      `Upstream replied with unsupported content type "${contentType}"`,
    );
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    const response = await this.post(notification, {});
    response.discard();
  }

  /**
   * Opens the optional GET stream used by servers that push notifications
   * outside a request. A 405 simply means the server does not offer one.
   */
  async openServerStream(): Promise<void> {
    if (this.serverStream || this.closed) return;
    const controller = new AbortController();
    this.serverStream = controller;

    const extra: Record<string, string> = { accept: SSE_CONTENT_TYPE };
    // RFC-style SSE resumption: the server replays what we missed rather than
    // starting again, so a dropped connection does not lose notifications.
    if (this.lastServerEventId) extra["last-event-id"] = this.lastServerEventId;
    const headers = await this.buildHeaders("GET", extra);

    let response: SafeResponse;
    try {
      response = await this.options.fetcher.request({
        url: this.options.url,
        method: "GET",
        headers,
        signal: controller.signal,
        stream: true,
        followRedirects: false,
        timeoutMs: 0,
      });
    } catch (error) {
      this.serverStream = null;
      this.options.logger.debug("Upstream does not provide a server stream", {
        error: (error as Error).message,
      });
      this.scheduleServerStreamRetry();
      return;
    }
    // 405 and 404 are the server saying it has no stream to give, which is a
    // permanent answer; anything else may be transient and is worth retrying.
    if (response.status === 405 || response.status === 404) {
      response.discard();
      this.serverStream = null;
      return;
    }
    if (response.status !== 200) {
      response.discard();
      this.serverStream = null;
      this.scheduleServerStreamRetry();
      return;
    }

    this.serverStreamAttempt = 0;
    void this.consumeServerStream(response)
      .catch((error: unknown) => {
        if (this.closed) return;
        this.options.logger.debug("Upstream server stream ended", {
          error: (error as Error).message,
        });
      })
      .finally(() => {
        // A stream that ends and is never reopened means notifications stop
        // arriving with nothing to say so.
        if (this.serverStream === controller) this.serverStream = null;
        this.scheduleServerStreamRetry();
      });
  }

  /** Reopens the server stream after a drop, backing off on repeated failure. */
  private scheduleServerStreamRetry(): void {
    if (this.closed || this.serverStream) return;
    const attempt = this.serverStreamAttempt;
    this.serverStreamAttempt = Math.min(attempt + 1, 6);
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    const timer = setTimeout(() => {
      void this.openServerStream().catch(() => undefined);
    }, delay);
    timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.serverStream?.abort();
    this.serverStream = null;
    // A request still on the wire would otherwise wait out its timeout against
    // a session this call is about to delete.
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    if (!this.session) return;
    try {
      const headers = await this.buildHeaders("DELETE", { accept: JSON_CONTENT_TYPE });
      const response = await this.options.fetcher.request({
        url: this.options.url,
        method: "DELETE",
        headers,
        followRedirects: false,
      });
      response.discard();
    } catch (error) {
      this.options.logger.debug("Upstream session delete failed", {
        error: (error as Error).message,
      });
    } finally {
      this.session = null;
    }
  }

  private async post(
    message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
    options: SendOptions,
    retriedWithNonce = false,
  ): Promise<SafeResponse> {
    const headers = await this.buildHeaders("POST", {
      accept: `${JSON_CONTENT_TYPE}, ${SSE_CONTENT_TYPE}`,
      "content-type": JSON_CONTENT_TYPE,
    });
    // Tracked so close() can end it. The caller's own signal is chained in
    // rather than replaced, so a downstream cancellation still reaches here.
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else
        options.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    if (this.closed) controller.abort();
    this.inFlight.add(controller);

    const requestOptions: Parameters<SafeFetcher["request"]>[0] = {
      url: this.options.url,
      method: "POST",
      headers,
      body: JSON.stringify(message),
      followRedirects: false,
      stream: true,
      signal: controller.signal,
      timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000,
    };
    if (this.options.maxResponseBytes !== undefined) {
      requestOptions.maxResponseBytes = this.options.maxResponseBytes;
    }

    let response: SafeResponse;
    try {
      response = await this.options.fetcher.request(requestOptions);
    } finally {
      this.inFlight.delete(controller);
    }

    const issuedSession = response.headers[MCP_SESSION_HEADER];
    if (issuedSession) this.session = issuedSession;

    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers["www-authenticate"];
      // A DPoP resource server may refuse the first proof purely to hand out a
      // nonce it wants echoed. That is one prescribed round trip, so it is
      // retried once with the nonce recorded rather than reported as a failure.
      const nonce = response.headers["dpop-nonce"];
      if (nonce && !retriedWithNonce) {
        response.discard();
        this.options.onDpopNonce?.(nonce);
        return this.post(message, options, true);
      }
      response.discard();
      throw new McpUnauthorizedError(
        "The upstream MCP server requires authorization",
        challenge,
      );
    }
    if (this.session && (response.status === 404 || response.status === 400)) {
      // A server that has forgotten our session answers 404 by the letter of
      // the spec, but the reference implementation answers 400 "Server not
      // initialized" once it has restarted, and restarting is the ordinary way
      // a session goes away. Both say the id we are holding buys us nothing.
      const detail = response.status === 400 ? await response.text().catch(() => "") : "";
      if (response.status === 404 || FORGOTTEN_SESSION.test(detail)) {
        response.discard();
        this.session = null;
        throw new McpSessionExpiredError();
      }
      throw new McpProtocolError(
        `Upstream MCP server returned HTTP 400${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    if (response.status === 202 || response.status === 204) {
      return response;
    }
    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => "");
      throw new McpProtocolError(
        `Upstream MCP server returned HTTP ${response.status}${
          body ? `: ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    return response;
  }

  private async readResponseFromStream(
    response: SafeResponse,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    try {
      for await (const event of readSseEvents(response.body)) {
        if (event.event !== "message" && event.data === "") continue;
        const payload = safeJsonParse(event.data);
        const messages = Array.isArray(payload) ? payload : [payload];
        for (const message of messages) {
          if (isJsonRpcResponse(message) && message.id === request.id) {
            return message;
          }
          this.dispatch(message);
        }
      }
    } finally {
      response.discard();
    }
    throw new McpProtocolError("Upstream stream closed before answering the request");
  }

  private async consumeServerStream(response: SafeResponse): Promise<void> {
    try {
      for await (const event of readSseEvents(response.body)) {
        if (event.id !== undefined) this.lastServerEventId = event.id;
        const payload = safeJsonParse(event.data);
        const messages = Array.isArray(payload) ? payload : [payload];
        for (const message of messages) this.dispatch(message);
      }
    } finally {
      response.discard();
    }
  }

  private dispatch(message: unknown): void {
    if (isJsonRpcNotification(message)) {
      this.options.hooks.onNotification?.(message);
      return;
    }
    if (isJsonRpcRequest(message)) {
      const handler = this.options.hooks.onServerRequest;
      if (!handler) return;
      void handler(message)
        .then((reply) => this.postMessage(reply))
        .catch((error: unknown) => {
          this.options.logger.warn("Failed to answer an upstream request", {
            error: (error as Error).message,
          });
        });
    }
  }

  private async postMessage(message: JsonRpcResponse): Promise<void> {
    const response = await this.post({ ...message, jsonrpc: JSONRPC_VERSION }, {});
    response.discard();
  }

  private async buildHeaders(
    method: string,
    extra: Record<string, string>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      ...(await this.options.authHeaders({ method, url: this.options.url })),
      ...extra,
    };
    if (this.session) headers[MCP_SESSION_HEADER] = this.session;
    if (this.protocolVersion) {
      headers[MCP_PROTOCOL_VERSION_HEADER] = this.protocolVersion;
    }
    return headers;
  }
}
