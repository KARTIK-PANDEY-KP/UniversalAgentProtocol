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
  authHeaders: () => Promise<Record<string, string>>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";

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
    const headers = await this.buildHeaders({ accept: SSE_CONTENT_TYPE });
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
      return;
    }
    if (response.status === 405 || response.status === 404) {
      response.discard();
      this.serverStream = null;
      return;
    }
    if (response.status !== 200) {
      response.discard();
      this.serverStream = null;
      return;
    }
    void this.consumeServerStream(response).catch((error: unknown) => {
      if (this.closed) return;
      this.options.logger.debug("Upstream server stream ended", {
        error: (error as Error).message,
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.serverStream?.abort();
    this.serverStream = null;
    if (!this.session) return;
    try {
      const headers = await this.buildHeaders({ accept: JSON_CONTENT_TYPE });
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
  ): Promise<SafeResponse> {
    const headers = await this.buildHeaders({
      accept: `${JSON_CONTENT_TYPE}, ${SSE_CONTENT_TYPE}`,
      "content-type": JSON_CONTENT_TYPE,
    });
    const requestOptions: Parameters<SafeFetcher["request"]>[0] = {
      url: this.options.url,
      method: "POST",
      headers,
      body: JSON.stringify(message),
      followRedirects: false,
      stream: true,
      timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000,
    };
    if (options.signal) requestOptions.signal = options.signal;
    if (this.options.maxResponseBytes !== undefined) {
      requestOptions.maxResponseBytes = this.options.maxResponseBytes;
    }
    const response = await this.options.fetcher.request(requestOptions);

    const issuedSession = response.headers[MCP_SESSION_HEADER];
    if (issuedSession) this.session = issuedSession;

    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers["www-authenticate"];
      response.discard();
      throw new McpUnauthorizedError(
        "The upstream MCP server requires authorization",
        challenge,
      );
    }
    if (response.status === 404 && this.session) {
      response.discard();
      this.session = null;
      throw new McpSessionExpiredError();
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
    extra: Record<string, string>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      ...(await this.options.authHeaders()),
      ...extra,
    };
    if (this.session) headers[MCP_SESSION_HEADER] = this.session;
    if (this.protocolVersion) {
      headers[MCP_PROTOCOL_VERSION_HEADER] = this.protocolVersion;
    }
    return headers;
  }
}
