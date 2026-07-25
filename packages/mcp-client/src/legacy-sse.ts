import {
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
  McpUnauthorizedError,
  type McpTransport,
  type SendOptions,
  type TransportHooks,
} from "./transport.js";

export interface HttpSseOptions {
  /** The SSE endpoint advertised by servers that predate Streamable HTTP. */
  url: string;
  fetcher: SafeFetcher;
  logger: Logger;
  hooks: TransportHooks;
  authHeaders: () => Promise<Record<string, string>>;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve(response: JsonRpcResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * The 2024-11-05 HTTP+SSE transport, kept for servers that have not migrated.
 * Requests are posted to an endpoint the server announces on the event stream,
 * and all responses arrive back on that same stream.
 */
export class HttpSseTransport implements McpTransport {
  readonly kind = "HTTP_SSE" as const;

  protocolVersion: string | null = null;
  readonly sessionId: string | null = null;

  private postUrl: string | null = null;
  private controller: AbortController | null = null;
  private readonly pending = new Map<string | number, Pending>();
  private closed = false;
  private ready: Promise<void> | null = null;

  constructor(private readonly options: HttpSseOptions) {}

  async connect(): Promise<void> {
    this.ready ??= this.openStream();
    return this.ready;
  }

  async send(
    request: JsonRpcRequest,
    options: SendOptions = {},
  ): Promise<JsonRpcResponse> {
    await this.connect();
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    const result = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new McpProtocolError("Timed out waiting for the upstream response"));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
    });
    await this.postMessage(request);
    return result;
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    await this.connect();
    await this.postMessage(notification);
  }

  async openServerStream(): Promise<void> {
    await this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    this.controller = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpProtocolError("Transport closed"));
    }
    this.pending.clear();
  }

  private async openStream(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const response = await this.options.fetcher.request({
      url: this.options.url,
      method: "GET",
      headers: { ...(await this.options.authHeaders()), accept: "text/event-stream" },
      signal: controller.signal,
      stream: true,
      followRedirects: false,
      timeoutMs: 0,
    });
    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers["www-authenticate"];
      response.discard();
      throw new McpUnauthorizedError(
        "The upstream MCP server requires authorization",
        challenge,
      );
    }
    if (response.status !== 200) {
      response.discard();
      throw new McpProtocolError(
        `Legacy SSE endpoint returned HTTP ${response.status}`,
      );
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new McpProtocolError("Server never announced a message endpoint"));
      }, this.options.requestTimeoutMs ?? 30_000);

      void (async () => {
        try {
          for await (const event of readSseEvents(response.body)) {
            if (event.event === "endpoint") {
              this.postUrl = new URL(event.data, this.options.url).toString();
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve();
              }
              continue;
            }
            const payload = safeJsonParse(event.data);
            const messages = Array.isArray(payload) ? payload : [payload];
            for (const message of messages) this.dispatch(message);
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error as Error);
          }
        } finally {
          clearTimeout(timer);
          response.discard();
          if (!this.closed) this.failPending();
        }
      })();
    });
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpProtocolError("Upstream event stream closed"));
    }
    this.pending.clear();
  }

  private dispatch(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      const id = "id" in message ? message.id : null;
      if (id === null) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(message);
      return;
    }
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

  private async postMessage(
    message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
  ): Promise<void> {
    if (!this.postUrl) {
      throw new McpProtocolError("Legacy transport has no message endpoint yet");
    }
    const response: SafeResponse = await this.options.fetcher.request({
      url: this.postUrl,
      method: "POST",
      headers: {
        ...(await this.options.authHeaders()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
      followRedirects: false,
    });
    if (response.status === 401 || response.status === 403) {
      const challenge = response.headers["www-authenticate"];
      response.discard();
      throw new McpUnauthorizedError(
        "The upstream MCP server requires authorization",
        challenge,
      );
    }
    if (response.status >= 400) {
      const body = await response.text().catch(() => "");
      throw new McpProtocolError(
        `Legacy message endpoint returned HTTP ${response.status}${
          body ? `: ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    response.discard();
  }
}
