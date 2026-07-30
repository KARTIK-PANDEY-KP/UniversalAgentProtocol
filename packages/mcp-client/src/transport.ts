import {
  GatewayError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@uap/core";

export interface TransportHooks {
  onNotification?(notification: JsonRpcNotification): void;
  /**
   * Handles a request initiated by the upstream server such as
   * `sampling/createMessage` or `elicitation/create`. Returning a JSON-RPC
   * error is how an unsupported capability is refused.
   */
  onServerRequest?(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export interface SendOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpTransport {
  readonly kind: "STREAMABLE_HTTP" | "HTTP_SSE";
  readonly sessionId: string | null;
  protocolVersion: string | null;
  send(request: JsonRpcRequest, options?: SendOptions): Promise<JsonRpcResponse>;
  notify(notification: JsonRpcNotification): Promise<void>;
  openServerStream(): Promise<void>;
  close(): Promise<void>;
}

/** The upstream demanded authorization; carries the raw challenge header. */
export class McpUnauthorizedError extends GatewayError {
  readonly wwwAuthenticate: string | undefined;

  constructor(message: string, wwwAuthenticate?: string) {
    super("UNAUTHENTICATED", message);
    this.name = "McpUnauthorizedError";
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/** The upstream no longer recognises the MCP session id. */
export class McpSessionExpiredError extends GatewayError {
  constructor() {
    super("UPSTREAM_PROTOCOL_ERROR", "The upstream MCP session expired", {
      retryable: true,
    });
    this.name = "McpSessionExpiredError";
  }
}

export class McpProtocolError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super("UPSTREAM_PROTOCOL_ERROR", message, { cause });
    this.name = "McpProtocolError";
  }
}
