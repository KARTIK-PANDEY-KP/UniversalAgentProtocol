import {
  GatewayError,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  McpMethod,
  isJsonRpcFailure,
  isRecord,
  negotiateProtocolVersion,
  toJsonObject,
  type JsonObject,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpImplementation,
  type McpInitializeResult,
  type McpPrompt,
  type McpPromptResult,
  type McpResource,
  type McpResourceContents,
  type McpResourceTemplate,
  type McpServerCapabilities,
  type McpTool,
  type McpToolResult,
  type RequestId,
  type UpstreamRequestTarget,
} from "@umg/core";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import type { SafeFetcher } from "@umg/security";

import { HttpSseTransport } from "./legacy-sse.js";
import { StreamableHttpTransport } from "./streamable-http.js";
import {
  McpProtocolError,
  McpSessionExpiredError,
  type McpTransport,
  type TransportHooks,
} from "./transport.js";

/** Enough pages for any real catalogue, few enough to catch a cursor loop. */
const MAX_PAGES = 100;

export interface ToolCallContext {
  progressToken?: string | number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Only idempotent calls are replayed after a session is recreated. */
  idempotent?: boolean;
}

export interface UpstreamConnectionOptions {
  url: string;
  fetcher: SafeFetcher;
  logger: Logger;
  metrics: MetricsRegistry;
  authHeaders: (request: UpstreamRequestTarget) => Promise<Record<string, string>>;
  /** Called when the upstream demands a DPoP nonce, before the retry. */
  onDpopNonce?: (nonce: string) => void;
  clientInfo: McpImplementation;
  clientCapabilities: McpClientCapabilities;
  hooks?: TransportHooks;
  transportKind?: "STREAMABLE_HTTP" | "HTTP_SSE";
  requestTimeoutMs?: number;
  /** Reuse a session id issued during an earlier process lifetime. */
  resumeSessionId?: string | null;
}

/**
 * A generic MCP client bound to one remote server. It knows nothing about the
 * provider behind the endpoint: capabilities, tools, resources and prompts are
 * all discovered at runtime.
 */
export class UpstreamMcpConnection {
  private transport: McpTransport | null = null;
  private nextId = 1;
  private initializeResult: McpInitializeResult | null = null;
  private negotiatedVersion: string | null = null;

  constructor(private readonly options: UpstreamConnectionOptions) {}

  get capabilities(): McpServerCapabilities {
    return this.initializeResult?.capabilities ?? {};
  }

  get serverInfo(): McpImplementation | null {
    return this.initializeResult?.serverInfo ?? null;
  }

  get protocolVersion(): string | null {
    return this.negotiatedVersion;
  }

  get sessionId(): string | null {
    return this.transport?.sessionId ?? null;
  }

  get transportKind(): "STREAMABLE_HTTP" | "HTTP_SSE" | null {
    return this.transport?.kind ?? null;
  }

  async initialize(): Promise<McpInitializeResult> {
    const transport = await this.ensureTransport();
    const response = await this.dispatch(
      transport,
      this.buildRequest(McpMethod.Initialize, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: this.options.clientCapabilities as unknown as JsonObject,
        clientInfo: this.options.clientInfo as unknown as JsonObject,
      }),
    );
    const result = this.unwrap(response);
    if (typeof result["protocolVersion"] !== "string") {
      throw new McpProtocolError("Initialize response has no protocol version");
    }
    this.negotiatedVersion = negotiateProtocolVersion(result["protocolVersion"]);
    transport.protocolVersion = this.negotiatedVersion;
    this.initializeResult = result as unknown as McpInitializeResult;

    await transport.notify({
      jsonrpc: JSONRPC_VERSION,
      method: McpMethod.Initialized,
    });
    await transport.openServerStream();
    this.options.metrics.counter(Metric.McpUpstreamConnection, {
      transport: transport.kind,
    });
    return this.initializeResult;
  }

  async listTools(): Promise<McpTool[]> {
    return this.collectPage<McpTool>(McpMethod.ToolsList, "tools");
  }

  async listResources(): Promise<McpResource[]> {
    if (!this.capabilities.resources) return [];
    return this.collectPage<McpResource>(McpMethod.ResourcesList, "resources");
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    if (!this.capabilities.resources) return [];
    try {
      return await this.collectPage<McpResourceTemplate>(
        McpMethod.ResourcesTemplatesList,
        "resourceTemplates",
      );
    } catch (error) {
      // Templates are an optional part of the resources capability and plenty
      // of servers advertise resources without them, so a failure here is not
      // allowed to fail the whole sync — but it is worth saying out loud.
      this.options.logger.debug("Upstream does not list resource templates", {
        error: (error as Error).message,
      });
      return [];
    }
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.capabilities.prompts) return [];
    return this.collectPage<McpPrompt>(McpMethod.PromptsList, "prompts");
  }

  async callTool(
    name: string,
    args: unknown,
    context: ToolCallContext = {},
  ): Promise<McpToolResult> {
    const params: JsonObject = {
      name,
      arguments: (args ?? {}) as JsonObject,
    };
    if (context.progressToken !== undefined) {
      params["_meta"] = { progressToken: context.progressToken };
    }
    const result = await this.request(McpMethod.ToolsCall, params, context);
    return result as unknown as McpToolResult;
  }

  async readResource(uri: string): Promise<McpResourceContents> {
    const result = await this.request(McpMethod.ResourcesRead, { uri }, {
      idempotent: true,
    });
    return result as unknown as McpResourceContents;
  }

  async subscribeResource(uri: string): Promise<void> {
    await this.request(McpMethod.ResourcesSubscribe, { uri }, { idempotent: true });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    await this.request(McpMethod.ResourcesUnsubscribe, { uri }, { idempotent: true });
  }

  async getPrompt(name: string, args: unknown): Promise<McpPromptResult> {
    const result = await this.request(
      McpMethod.PromptsGet,
      { name, arguments: (args ?? {}) as JsonObject },
      { idempotent: true },
    );
    return result as unknown as McpPromptResult;
  }

  async ping(): Promise<void> {
    await this.request(McpMethod.Ping, {}, { idempotent: true, timeoutMs: 10_000 });
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
    this.initializeResult = null;
  }

  /** Issues an arbitrary MCP request, used for methods the gateway proxies verbatim. */
  async request(
    method: string,
    params: JsonObject,
    context: ToolCallContext = {},
  ): Promise<JsonObject> {
    const transport = await this.ensureTransport();
    const request = this.buildRequest(method, params);
    try {
      const response = await this.dispatch(transport, request, context);
      return this.unwrap(response);
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      this.options.metrics.counter(Metric.McpSessionRecreated, { method });
      await this.recreateSession();
      if (context.idempotent !== true) {
        throw new GatewayError(
          "UPSTREAM_PROTOCOL_ERROR",
          "The upstream MCP session expired during a non-idempotent call; retry explicitly",
          { retryable: false },
        );
      }
      const retryTransport = await this.ensureTransport();
      const response = await this.dispatch(
        retryTransport,
        this.buildRequest(method, params),
        context,
      );
      return this.unwrap(response);
    }
  }

  private async recreateSession(): Promise<void> {
    await this.transport?.close().catch(() => undefined);
    this.transport = null;
    this.initializeResult = null;
    await this.initialize();
  }

  private async dispatch(
    transport: McpTransport,
    request: JsonRpcRequest,
    context: ToolCallContext = {},
  ): Promise<JsonRpcResponse> {
    const options: { timeoutMs?: number; signal?: AbortSignal } = {};
    if (context.timeoutMs !== undefined) options.timeoutMs = context.timeoutMs;
    if (context.signal) options.signal = context.signal;

    if (!context.signal) return transport.send(request, options);

    const onAbort = (): void => {
      void transport
        .notify({
          jsonrpc: JSONRPC_VERSION,
          method: McpMethod.Cancelled,
          params: { requestId: request.id, reason: "Downstream client cancelled" },
        })
        .catch(() => undefined);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await transport.send(request, options);
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  private async collectPage<T>(method: string, field: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: JsonObject = cursor === undefined ? {} : { cursor };
      const result = await this.request(method, params, { idempotent: true });
      const values = result[field];
      if (Array.isArray(values)) items.push(...(values as T[]));
      const next = result["nextCursor"];
      if (typeof next !== "string" || next === "") return items;
      cursor = next;
    }
    // Storing a partial catalogue as if it were complete would silently hide
    // tools from every downstream client, so this fails loudly instead.
    throw new GatewayError(
      "UPSTREAM_PROTOCOL_ERROR",
      `Upstream ${method} still had more pages after ${MAX_PAGES}`,
    );
  }

  private buildRequest(method: string, params: JsonObject): JsonRpcRequest {
    const id: RequestId = this.nextId;
    this.nextId += 1;
    return { jsonrpc: JSONRPC_VERSION, id, method, params };
  }

  private unwrap(response: JsonRpcResponse): JsonObject {
    if (isJsonRpcFailure(response)) {
      throw new GatewayError(
        "UPSTREAM_PROTOCOL_ERROR",
        response.error.message || "Upstream MCP error",
        { data: { code: response.error.code, data: response.error.data ?? null } },
      );
    }
    return isRecord(response.result) ? toJsonObject(response.result) : {};
  }

  private async ensureTransport(): Promise<McpTransport> {
    if (this.transport) return this.transport;
    const hooks: TransportHooks = this.options.hooks ?? {};
    if (this.options.transportKind === "HTTP_SSE") {
      const transport = new HttpSseTransport({
        url: this.options.url,
        fetcher: this.options.fetcher,
        logger: this.options.logger,
        hooks,
        authHeaders: this.options.authHeaders,
        ...(this.options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: this.options.requestTimeoutMs }),
      });
      await transport.connect();
      this.transport = transport;
      return transport;
    }
    const transport = new StreamableHttpTransport({
      url: this.options.url,
      fetcher: this.options.fetcher,
      logger: this.options.logger,
      hooks,
      authHeaders: this.options.authHeaders,
      ...(this.options.onDpopNonce ? { onDpopNonce: this.options.onDpopNonce } : {}),
      ...(this.options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.options.requestTimeoutMs }),
    });
    if (this.options.resumeSessionId) {
      transport.setSessionId(this.options.resumeSessionId);
    }
    this.transport = transport;
    return transport;
  }
}
