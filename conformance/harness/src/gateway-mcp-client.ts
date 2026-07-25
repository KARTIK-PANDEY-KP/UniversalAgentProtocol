import {
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  McpMethod,
  type JsonObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpImplementation,
  type McpTool,
  type RequestId,
} from "@umg/core";

import { readSse } from "./sse-reader.js";

export interface GatewayMcpClientOptions {
  baseUrl: string;
  apiKey: string;
  clientInfo?: McpImplementation;
  capabilities?: McpClientCapabilities;
  /** Protocol version to request; defaults to the newest the gateway knows. */
  protocolVersion?: string;
  /** Answers `elicitation/create` requests the gateway forwards. */
  onElicitation?(params: JsonObject): JsonObject;
  /** Answers `sampling/createMessage` requests the gateway forwards. */
  onSampling?(params: JsonObject): JsonObject;
}

export class GatewayMcpClientError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "GatewayMcpClientError";
  }
}

export interface CallToolOptions {
  /** Requests progress notifications and receives them as they arrive. */
  onProgress?(params: JsonObject): void;
  /** Receives the JSON-RPC id of the outgoing request, so it can be cancelled. */
  onRequestId?(id: RequestId): void;
  stream?: boolean;
}

/**
 * Stands in for Cursor, Claude Code, Codex or any other MCP host. It speaks
 * the Streamable HTTP transport against the gateway with the platform fetch,
 * so a passing test proves the wire behaviour rather than the gateway's own
 * client code agreeing with itself.
 */
export class GatewayMcpClient {
  private sessionId: string | null = null;
  private protocolVersion: string = LATEST_PROTOCOL_VERSION;
  private nextId = 1;
  private streamController: AbortController | null = null;
  private streamClosed: Promise<void> | null = null;
  private lastEventId: string | null = null;

  readonly notifications: JsonRpcNotification[] = [];

  constructor(private readonly options: GatewayMcpClientOptions) {}

  get mcpUrl(): string {
    return `${this.options.baseUrl}/mcp`;
  }

  get session(): string | null {
    return this.sessionId;
  }

  async initialize(): Promise<JsonObject> {
    const request = this.build(McpMethod.Initialize, {
      protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
      capabilities: (this.options.capabilities ?? {}) as unknown as JsonObject,
      clientInfo: (this.options.clientInfo ?? {
        name: "conformance-client",
        version: "1.0.0",
      }) as unknown as JsonObject,
    });
    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(request),
    });
    this.sessionId = response.headers.get("mcp-session-id");
    const payload = (await response.json()) as JsonRpcResponse;
    const result = this.unwrap(payload);
    if (typeof result["protocolVersion"] === "string") {
      this.protocolVersion = result["protocolVersion"];
    }
    await this.notify(McpMethod.Initialized, {});
    return result;
  }

  /**
   * Opens the GET event stream that carries notifications and server requests.
   * `resume` replays from the last event id seen, the way an SSE client
   * reconnects after the connection drops; `resumeFrom` names an earlier id,
   * for tests that need to prove the replay window is honoured.
   */
  async openStream(
    options: { resume?: boolean; resumeFrom?: string } = {},
  ): Promise<void> {
    if (this.streamController) return;
    const controller = new AbortController();
    this.streamController = controller;
    const extra: Record<string, string> = { accept: "text/event-stream" };
    const from =
      options.resumeFrom ?? (options.resume ? (this.lastEventId ?? undefined) : undefined);
    if (from !== undefined) extra["last-event-id"] = from;
    const response = await fetch(this.mcpUrl, {
      method: "GET",
      headers: this.headers(extra),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      this.streamController = null;
      throw new Error(`Gateway refused the event stream: HTTP ${response.status}`);
    }
    let ready: () => void = () => undefined;
    this.streamClosed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    void (async () => {
      try {
        for await (const event of readSse(response.body as ReadableStream<Uint8Array>)) {
          if (event.id !== null) this.lastEventId = event.id;
          this.handleStreamMessage(JSON.parse(event.data) as unknown);
        }
      } catch {
        // The stream ends when the client closes or the session is dropped.
      } finally {
        ready();
      }
    })();
    // Give the gateway a moment to register the stream before the first call.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async listTools(): Promise<McpTool[]> {
    return (await this.drain(McpMethod.ToolsList, "tools")) as unknown as McpTool[];
  }

  async listPrompts(): Promise<JsonObject[]> {
    return this.drain(McpMethod.PromptsList, "prompts");
  }

  async getPrompt(name: string, args: JsonObject = {}): Promise<JsonObject> {
    return this.request(McpMethod.PromptsGet, { name, arguments: args });
  }

  async listResources(): Promise<JsonObject[]> {
    return this.drain(McpMethod.ResourcesList, "resources");
  }

  /** Follows `nextCursor` the way a conforming client does. */
  private async drain(method: string, field: string): Promise<JsonObject[]> {
    const items: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request(
        method,
        cursor === undefined ? {} : { cursor },
      );
      items.push(...((result[field] ?? []) as JsonObject[]));
      const next = result["nextCursor"];
      cursor = typeof next === "string" ? next : undefined;
    } while (cursor !== undefined);
    return items;
  }

  async readResource(uri: string): Promise<JsonObject> {
    return this.request(McpMethod.ResourcesRead, { uri });
  }

  async callTool(
    name: string,
    args: JsonObject = {},
    options: CallToolOptions = {},
  ): Promise<JsonObject> {
    const params: JsonObject = { name, arguments: args };
    if (options.onProgress) {
      params["_meta"] = { progressToken: `p-${this.nextId}` };
    }
    return this.request(McpMethod.ToolsCall, params, options);
  }

  async request(
    method: string,
    params: JsonObject,
    options: CallToolOptions = {},
  ): Promise<JsonObject> {
    const request = this.build(method, params);
    options.onRequestId?.(request.id);
    const streaming = options.stream ?? options.onProgress !== undefined;
    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: streaming
          ? "application/json, text/event-stream"
          : "application/json",
      }),
      body: JSON.stringify(request),
    });

    if (response.status === 401) {
      throw new GatewayMcpClientError("Gateway rejected the credential", 401, {
        wwwAuthenticate: response.headers.get("www-authenticate"),
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("text/event-stream") && response.body) {
      return this.readStreamedResponse(
        response.body as ReadableStream<Uint8Array>,
        request,
        options,
      );
    }
    return this.unwrap((await response.json()) as JsonRpcResponse);
  }

  /** Asks the gateway to stop working on a request it is still answering. */
  async cancel(requestId: RequestId, reason = "Cancelled by the user"): Promise<void> {
    await this.notify(McpMethod.Cancelled, { requestId, reason });
  }

  async notify(method: string, params: JsonObject): Promise<void> {
    await fetch(this.mcpUrl, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params }),
    });
  }

  /** Drops the event stream but keeps the session, as a network blip would. */
  async closeStream(): Promise<void> {
    this.streamController?.abort();
    this.streamController = null;
    if (this.streamClosed) await this.streamClosed.catch(() => undefined);
    this.streamClosed = null;
  }

  async close(): Promise<void> {
    await this.closeStream();
    if (!this.sessionId) return;
    await fetch(this.mcpUrl, { method: "DELETE", headers: this.headers({}) }).catch(
      () => undefined,
    );
    this.sessionId = null;
  }

  private async readStreamedResponse(
    body: ReadableStream<Uint8Array>,
    request: JsonRpcRequest,
    options: CallToolOptions,
  ): Promise<JsonObject> {
    for await (const event of readSse(body)) {
      const message = JSON.parse(event.data) as
        | JsonRpcResponse
        | JsonRpcNotification
        | JsonRpcRequest;
      if ("method" in message) {
        // MCP puts a server-to-client request on the stream carrying the
        // request that caused it, which for a client that never opened the
        // standalone stream is this one. Answering it is the client's job.
        if ("id" in message) {
          void this.answerServerRequest(message);
        } else if (message.method === McpMethod.Progress) {
          options.onProgress?.((message.params ?? {}) as JsonObject);
        } else {
          this.notifications.push(message);
        }
        continue;
      }
      if (message.id === request.id) return this.unwrap(message);
    }
    throw new Error("The gateway stream ended before answering the request");
  }

  private handleStreamMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    if ("method" in message && !("id" in message)) {
      this.notifications.push(message as JsonRpcNotification);
      return;
    }
    if ("method" in message && "id" in message) {
      void this.answerServerRequest(message as JsonRpcRequest);
    }
  }

  private async answerServerRequest(request: JsonRpcRequest): Promise<void> {
    const params = (request.params ?? {}) as JsonObject;
    let result: JsonObject | null = null;
    if (request.method === McpMethod.ElicitationCreate) {
      result = this.options.onElicitation?.(params) ?? null;
    } else if (request.method === McpMethod.SamplingCreateMessage) {
      result = this.options.onSampling?.(params) ?? null;
    }
    const body: JsonRpcResponse =
      result === null
        ? {
            jsonrpc: JSONRPC_VERSION,
            id: request.id,
            error: { code: -32601, message: `Unsupported: ${request.method}` },
          }
        : { jsonrpc: JSONRPC_VERSION, id: request.id, result };
    await fetch(this.mcpUrl, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }

  private build(method: string, params: JsonObject): JsonRpcRequest {
    const id = this.nextId;
    this.nextId += 1;
    return { jsonrpc: JSONRPC_VERSION, id, method, params };
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      ...extra,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.sessionId) headers["mcp-protocol-version"] = this.protocolVersion;
    return headers;
  }

  private unwrap(response: JsonRpcResponse): JsonObject {
    if ("error" in response) {
      throw new GatewayMcpClientError(
        response.error.message,
        response.error.code,
        response.error.data ?? null,
      );
    }
    return (response.result ?? {}) as JsonObject;
  }
}
