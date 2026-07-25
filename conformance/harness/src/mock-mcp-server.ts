import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpMethod,
  type JsonObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpPrompt,
  type McpResource,
  type McpToolResult,
} from "@umg/core";

import {
  HttpFixture,
  headerOf,
  json,
  type FixtureRequest,
} from "./http-fixture.js";
import { verifyDpopProof } from "./dpop-verifier.js";

export interface ToolCallHooks {
  /** Emits a progress notification on the stream carrying this call. */
  progress(progress: number, total?: number, message?: string): void;
  /** Issues a server-to-client request and waits for the client's answer. */
  request(method: string, params: JsonObject): Promise<JsonRpcResponse>;
  /** True when the response is being streamed and can carry notifications. */
  streaming: boolean;
  /** Settles when the caller cancels this request, so a handler can give up. */
  cancelled: Promise<void>;
}

export interface MockToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  annotations?: JsonObject;
  /** Rejects the call with `insufficient_scope` unless the token has it. */
  requiredScope?: string;
  /**
   * How the refusal is shaped. `challenge` is the RFC 6750 form, a 403 with
   * `WWW-Authenticate`; `jsonrpc` is the shortcut some servers take of failing
   * the call and naming the error in the message.
   */
  scopeErrorStyle?: "challenge" | "jsonrpc";
  handler?(args: JsonObject, hooks: ToolCallHooks): Promise<McpToolResult> | McpToolResult;
}

export interface MockPromptDefinition extends McpPrompt {
  messages?: JsonObject[];
}

/** Suggestions this server returns for `completion/complete`. */
export type MockCompleter = (ref: JsonObject, argument: JsonObject) => string[];

export interface MockResourceDefinition extends McpResource {
  text?: string;
}

export interface TokenIntrospection {
  active: boolean;
  scopes: string[];
  resource: string | null;
  /** JWK thumbprint the token is bound to, for a DPoP grant. */
  confirmation?: string | null;
}

export interface MockMcpServerOptions {
  name?: string;
  version?: string;
  /** Path the MCP endpoint is served from. */
  path?: string;
  requireAuth?: boolean;
  authorizationServers?: string[];
  scopesSupported?: string[];
  introspect?(token: string): TokenIntrospection;
  transport?: "STREAMABLE_HTTP" | "HTTP_SSE";
  /** Issue and require an `Mcp-Session-Id`. */
  stateful?: boolean;
  tools?: MockToolDefinition[];
  resources?: MockResourceDefinition[];
  prompts?: MockPromptDefinition[];
  /** Answers `completion/complete`; omit it to declare no such capability. */
  complete?: MockCompleter;
  /** Refuse the first DPoP proof to hand out a nonce, as RFC 9449 allows. */
  requireDpopNonce?: boolean;
  /** Include `resource_metadata` in the 401 challenge. */
  advertiseResourceMetadata?: boolean;
  /** Serve protected resource metadata that a test can corrupt. */
  protectedResourceMetadataOverrides?: Record<string, unknown>;
  /** Serve no protected resource metadata at all. */
  omitProtectedResourceMetadata?: boolean;
}

export interface McpServerStats {
  initializes: number;
  toolCalls: number;
  requestsByMethod: Record<string, number>;
  authorizationHeadersSeen: string[];
  /** Request ids named by the `notifications/cancelled` this server received. */
  cancellations: (string | number)[];
  /** Methods of every client notification received, cancellations included. */
  notifications: string[];
  /** The most recent level a client set through `logging/setLevel`. */
  logLevel: string | null;
  /** How many times a client has opened the server-to-client GET stream. */
  serverStreamOpens: number;
  /** The `Last-Event-ID` on each of those opens, null when there was none. */
  resumedFrom: (string | null)[];
}

interface Session {
  id: string;
  protocolVersion: string;
  stream: ServerResponse | null;
}

const DEFAULT_TOOL_SCHEMA: JsonObject = {
  type: "object",
  properties: { input: { type: "string" } },
};

/**
 * A configurable remote MCP server. It speaks the Streamable HTTP transport by
 * default and the 2024-11-05 HTTP+SSE transport on request, so the gateway's
 * southbound client can be exercised against both.
 */
export class MockMcpServer {
  private readonly fixture: HttpFixture;
  private readonly sessions = new Map<string, Session>();
  private readonly openStreams = new Set<ServerResponse>();
  private readonly pendingServerRequests = new Map<
    string | number,
    (response: JsonRpcResponse) => void
  >();
  /** Resolvers for handlers waiting to hear that their call was cancelled. */
  private readonly cancelWaiters = new Map<string | number, () => void>();
  private tools: MockToolDefinition[];
  private resources: MockResourceDefinition[];
  private prompts: MockPromptDefinition[];
  private nextServerRequestId = 1;
  private failuresRemaining = 0;
  /** Nonce this server last handed out per endpoint, when it demands one. */
  private readonly issuedNonces = new Map<string, string>();
  private nextNonce = 1;
  private failureStatus = 500;

  readonly stats: McpServerStats = {
    initializes: 0,
    toolCalls: 0,
    requestsByMethod: {},
    authorizationHeadersSeen: [],
    cancellations: [],
    notifications: [],
    logLevel: null,
    serverStreamOpens: 0,
    resumedFrom: [],
  };

  constructor(private readonly options: MockMcpServerOptions = {}) {
    this.tools = options.tools ?? [];
    this.resources = options.resources ?? [];
    this.prompts = options.prompts ?? [];
    this.fixture = new HttpFixture((request, res) => this.route(request, res));
  }

  get baseUrl(): string {
    return this.fixture.baseUrl;
  }

  get path(): string {
    return this.options.path ?? "/mcp";
  }

  get url(): string {
    return `${this.fixture.baseUrl}${this.path}`;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** The session ids this server handed out, so a test can look for leaks. */
  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async start(): Promise<string> {
    await this.fixture.start();
    return this.url;
  }

  async stop(): Promise<void> {
    for (const stream of this.openStreams) stream.end();
    this.openStreams.clear();
    this.sessions.clear();
    await this.fixture.stop();
  }

  /**
   * Replaces the catalogue. `announce` is false for servers that change
   * quietly and leave clients to notice on their next poll, which is the
   * majority of them.
   */
  setTools(tools: MockToolDefinition[], announce = true): void {
    this.tools = tools;
    if (announce) {
      this.broadcast({ jsonrpc: JSONRPC_VERSION, method: McpMethod.ToolListChanged });
    }
  }

  setResources(resources: MockResourceDefinition[], announce = true): void {
    this.resources = resources;
    if (announce) {
      this.broadcast({ jsonrpc: JSONRPC_VERSION, method: McpMethod.ResourceListChanged });
    }
  }

  setPrompts(prompts: MockPromptDefinition[], announce = true): void {
    this.prompts = prompts;
    if (announce) {
      this.broadcast({ jsonrpc: JSONRPC_VERSION, method: McpMethod.PromptListChanged });
    }
  }

  /** Drops every session so the next request is answered with HTTP 404. */
  expireSessions(): void {
    this.sessions.clear();
  }

  /**
   * Ends every server-to-client stream without ending the session, which is
   * what a proxy timing out an idle connection looks like from the client.
   */
  dropServerStreams(): void {
    for (const stream of this.openStreams) stream.end();
    this.openStreams.clear();
    for (const session of this.sessions.values()) session.stream = null;
  }

  failNextRequests(count: number, status = 500): void {
    this.failuresRemaining = count;
    this.failureStatus = status;
  }

  broadcast(notification: JsonRpcNotification): void {
    for (const stream of this.openStreams) writeSseEvent(stream, notification);
  }

  /** Tells subscribers that a resource changed, as a real server would. */
  notifyResourceUpdated(uri: string): void {
    this.broadcast({
      jsonrpc: JSONRPC_VERSION,
      method: McpMethod.ResourceUpdated,
      params: { uri },
    });
  }

  /**
   * Emits a log line at the given severity. Servers that honour
   * `logging/setLevel` filter for themselves, so this deliberately does not
   * consult `stats.logLevel`: it lets a test drive a chatty upstream and check
   * that the gateway filters on the client's behalf.
   */
  emitLog(level: string, data: JsonObject): void {
    this.broadcast({
      jsonrpc: JSONRPC_VERSION,
      method: McpMethod.LoggingMessage,
      params: { level, logger: this.options.name ?? "mock-mcp-server", data },
    });
  }

  /**
   * Opens an event stream and immediately writes a comment. Without a first
   * write Node buffers the response head, and a client waiting on the stream
   * would never see it open.
   */
  private openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": open\n\n");
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.url,
      authorization_servers: this.options.authorizationServers ?? [],
      scopes_supported: this.options.scopesSupported ?? [],
      bearer_methods_supported: ["header"],
      resource_name: this.options.name ?? "Mock MCP Server",
      ...(this.options.protectedResourceMetadataOverrides ?? {}),
    };
  }

  private async route(request: FixtureRequest, res: ServerResponse): Promise<void> {
    const path = request.url.pathname;

    if (
      request.method === "GET" &&
      path.startsWith("/.well-known/oauth-protected-resource")
    ) {
      if (this.options.omitProtectedResourceMetadata) {
        json(res, 404, { error: "not_found" });
        return;
      }
      json(res, 200, this.protectedResourceMetadata());
      return;
    }

    if (path !== this.path && path !== `${this.path}/message`) return;

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      json(res, this.failureStatus, { error: "upstream_failure" });
      return;
    }

    const authorization = headerOf(request, "authorization");
    if (authorization) this.stats.authorizationHeadersSeen.push(authorization);
    const introspection = this.authorize(authorization);
    if (!introspection) {
      this.sendChallenge(res);
      return;
    }
    // A token bound to a key is only good when the matching proof arrives with
    // it, otherwise anyone who stole the token could use it.
    if (introspection.confirmation) {
      const refusal = this.checkProof(request, authorization ?? "", introspection.confirmation);
      if (refusal) {
        json(res, 401, { error: refusal.error }, refusal.headers);
        return;
      }
    }

    if ((this.options.transport ?? "STREAMABLE_HTTP") === "HTTP_SSE") {
      await this.routeLegacy(request, res, introspection);
      return;
    }
    await this.routeStreamable(request, res, introspection);
  }

  private authorize(authorization: string | undefined): TokenIntrospection | null {
    if (this.options.requireAuth !== true) {
      return { active: true, scopes: [], resource: null };
    }
    const scheme = authorization?.split(" ")[0]?.toLowerCase();
    if (scheme !== "bearer" && scheme !== "dpop") return null;
    const token = (authorization ?? "").slice(scheme.length).trim();
    const introspection = this.options.introspect?.(token) ?? {
      active: token.length > 0,
      scopes: [],
      resource: null,
    };
    return introspection.active ? introspection : null;
  }

  /**
   * Verifies the DPoP proof presented with a bound token. Returns the refusal
   * to send, or null when the proof is good.
   */
  private checkProof(
    request: FixtureRequest,
    authorization: string,
    confirmation: string,
  ): { error: string; headers: Record<string, string> } | null {
    const htu = `${this.fixture.baseUrl}${request.url.pathname}`;
    const expectedNonce = this.issuedNonces.get(htu);
    if (this.options.requireDpopNonce && expectedNonce === undefined) {
      const nonce = `nonce_${this.nextNonce++}`;
      this.issuedNonces.set(htu, nonce);
      return {
        error: "use_dpop_nonce",
        headers: {
          "dpop-nonce": nonce,
          "www-authenticate": 'DPoP error="use_dpop_nonce"',
        },
      };
    }
    try {
      const verified = verifyDpopProof(headerOf(request, "dpop"), {
        htm: request.method,
        htu,
        accessToken: authorization.split(" ")[1] ?? "",
        ...(expectedNonce === undefined ? {} : { nonce: expectedNonce }),
      });
      if (verified.thumbprint !== confirmation) {
        return {
          error: "invalid_token",
          headers: { "www-authenticate": 'DPoP error="invalid_token"' },
        };
      }
      return null;
    } catch {
      return {
        error: "invalid_dpop_proof",
        headers: { "www-authenticate": 'DPoP error="invalid_dpop_proof"' },
      };
    }
  }

  /** The scope a batch of requests needs but the token does not carry. */
  private scopeViolation(
    requests: JsonRpcRequest[],
    introspection: TokenIntrospection,
  ): string | null {
    for (const request of requests) {
      if (request.method !== McpMethod.ToolsCall) continue;
      const name = String((request.params ?? {})["name"] ?? "");
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (!tool || (tool.scopeErrorStyle ?? "challenge") !== "challenge") continue;
      const missing = missingScope(tool, introspection);
      if (missing) return missing;
    }
    return null;
  }

  private sendScopeChallenge(res: ServerResponse, scope: string): void {
    json(
      res,
      403,
      { error: "insufficient_scope" },
      {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      },
    );
  }

  private sendChallenge(res: ServerResponse): void {
    const parts = ['Bearer error="invalid_token"'];
    if (this.options.advertiseResourceMetadata !== false) {
      parts.push(
        `resource_metadata="${this.fixture.baseUrl}/.well-known/oauth-protected-resource${this.path}"`,
      );
    }
    const scopes = this.options.scopesSupported ?? [];
    if (scopes.length > 0) parts.push(`scope="${scopes.join(" ")}"`);
    json(res, 401, { error: "unauthorized" }, { "www-authenticate": parts.join(", ") });
  }

  private async routeStreamable(
    request: FixtureRequest,
    res: ServerResponse,
    introspection: TokenIntrospection,
  ): Promise<void> {
    if (request.method === "DELETE") {
      const id = headerOf(request, "mcp-session-id");
      if (id) this.sessions.delete(id);
      res.writeHead(204, { "content-length": 0 });
      res.end();
      return;
    }

    if (request.method === "GET") {
      const session = this.resolveSession(request);
      if (this.options.stateful && !session) {
        json(res, 404, { error: "unknown_session" });
        return;
      }
      this.stats.serverStreamOpens += 1;
      const resumeFrom = request.headers["last-event-id"];
      this.stats.resumedFrom.push(typeof resumeFrom === "string" ? resumeFrom : null);
      this.openEventStream(res);
      this.openStreams.add(res);
      if (session) session.stream = res;
      res.on("close", () => {
        this.openStreams.delete(res);
        if (session?.stream === res) session.stream = null;
      });
      return;
    }

    if (request.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST, DELETE", "content-length": 0 });
      res.end();
      return;
    }

    const parsed = JSON.parse(request.body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) this.noteNotification(message);

    // Answers to server-initiated requests come back as plain POSTs.
    const responses = messages.filter(isResponse);
    if (responses.length > 0 && messages.length === responses.length) {
      for (const response of responses) {
        this.pendingServerRequests.get(response.id)?.(response);
        this.pendingServerRequests.delete(response.id);
      }
      res.writeHead(202, { "content-length": 0 });
      res.end();
      return;
    }

    const initialize = messages.find(
      (message) => isRequest(message) && message.method === McpMethod.Initialize,
    ) as JsonRpcRequest | undefined;
    if (initialize) {
      const session = this.createSession(initialize);
      const headers: Record<string, string> = this.options.stateful
        ? { "mcp-session-id": session.id }
        : {};
      this.stats.initializes += 1;
      json(res, 200, success(initialize.id, this.initializeResult(session)), headers);
      return;
    }

    if (this.options.stateful && !this.resolveSession(request)) {
      json(res, 404, { error: "session_expired" });
      return;
    }

    const requests = messages.filter(isRequest);
    if (requests.length === 0) {
      res.writeHead(202, { "content-length": 0 });
      res.end();
      return;
    }

    // A resource server refuses a too-narrow token before doing any work, so
    // this is checked ahead of deciding whether to stream the response.
    const underscoped = this.scopeViolation(requests, introspection);
    if (underscoped) {
      this.sendScopeChallenge(res, underscoped);
      return;
    }

    const accept = headerOf(request, "accept") ?? "";
    const wantsStream =
      accept.includes("text/event-stream") &&
      requests.some((candidate) => candidate.method === McpMethod.ToolsCall);

    if (!wantsStream) {
      const results: JsonRpcResponse[] = [];
      for (const candidate of requests) {
        results.push(await this.execute(candidate, introspection, null));
      }
      json(res, 200, results.length === 1 ? results[0] : results);
      return;
    }

    this.openEventStream(res);
    for (const candidate of requests) {
      writeSseEvent(res, await this.execute(candidate, introspection, res));
    }
    res.end();
  }

  /** The 2024-11-05 transport: one GET stream plus a separate POST endpoint. */
  private async routeLegacy(
    request: FixtureRequest,
    res: ServerResponse,
    introspection: TokenIntrospection,
  ): Promise<void> {
    if (request.method === "GET") {
      const session = this.createSession(null);
      this.openEventStream(res);
      this.openStreams.add(res);
      session.stream = res;
      res.on("close", () => {
        this.openStreams.delete(res);
        this.sessions.delete(session.id);
      });
      res.write(
        `event: endpoint\ndata: ${this.path}/message?sessionId=${session.id}\n\n`,
      );
      return;
    }
    if (request.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST", "content-length": 0 });
      res.end();
      return;
    }

    const session = this.sessions.get(request.url.searchParams.get("sessionId") ?? "");
    if (!session?.stream) {
      json(res, 404, { error: "unknown_session" });
      return;
    }

    const message = JSON.parse(request.body) as unknown;
    this.noteNotification(message);
    res.writeHead(202, { "content-length": 0 });
    res.end();

    if (isResponse(message)) {
      this.pendingServerRequests.get(message.id)?.(message);
      this.pendingServerRequests.delete(message.id);
      return;
    }
    if (!isRequest(message)) return;
    if (message.method === McpMethod.Initialize) {
      this.stats.initializes += 1;
      writeSseEvent(session.stream, success(message.id, this.initializeResult(session)));
      return;
    }
    writeSseEvent(
      session.stream,
      await this.execute(message, introspection, session.stream),
    );
  }

  /**
   * Records an incoming client notification. A `notifications/cancelled` also
   * releases the handler waiting on it, which is how a real server learns it
   * can stop working.
   */
  private noteNotification(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    if (isRequest(message) || isResponse(message)) return;
    const method = (message as { method?: unknown }).method;
    if (typeof method !== "string") return;
    this.stats.notifications.push(method);
    if (method !== McpMethod.Cancelled) return;
    const requestId = (message as JsonRpcNotification).params?.["requestId"];
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    this.stats.cancellations.push(requestId);
    this.cancelWaiters.get(requestId)?.();
    this.cancelWaiters.delete(requestId);
  }

  private createSession(initialize: JsonRpcRequest | null): Session {
    const requested = initialize?.params?.["protocolVersion"];
    const session: Session = {
      id: `sess_${randomUUID()}`,
      protocolVersion:
        typeof requested === "string" ? requested : LATEST_PROTOCOL_VERSION,
      stream: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private resolveSession(request: FixtureRequest): Session | undefined {
    const id = headerOf(request, "mcp-session-id");
    return id ? this.sessions.get(id) : undefined;
  }

  private initializeResult(session: Session): JsonObject {
    return {
      protocolVersion: session.protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        ...(this.options.complete ? { completions: {} } : {}),
      },
      serverInfo: {
        name: this.options.name ?? "mock-mcp-server",
        version: this.options.version ?? "1.0.0",
      },
    };
  }

  private async execute(
    request: JsonRpcRequest,
    introspection: TokenIntrospection,
    stream: ServerResponse | null,
  ): Promise<JsonRpcResponse> {
    this.stats.requestsByMethod[request.method] =
      (this.stats.requestsByMethod[request.method] ?? 0) + 1;
    const params = request.params ?? {};

    switch (request.method) {
      case McpMethod.Ping:
        return success(request.id, {});
      case McpMethod.ToolsList:
        return success(request.id, {
          tools: this.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema ?? DEFAULT_TOOL_SCHEMA,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        });
      case McpMethod.ResourcesList:
        return success(request.id, {
          resources: this.resources.map(({ text: _text, ...resource }) => resource),
        });
      case McpMethod.ResourcesTemplatesList:
        return success(request.id, { resourceTemplates: [] });
      case McpMethod.ResourcesRead: {
        const uri = String(params["uri"] ?? "");
        const resource = this.resources.find((candidate) => candidate.uri === uri);
        if (!resource) {
          return failure(request.id, JsonRpcErrorCode.InvalidParams, "Unknown resource");
        }
        return success(request.id, {
          contents: [{ uri, mimeType: resource.mimeType ?? "text/plain", text: resource.text ?? "" }],
        });
      }
      case McpMethod.ResourcesSubscribe:
      case McpMethod.ResourcesUnsubscribe:
        return success(request.id, {});
      case McpMethod.CompletionComplete: {
        if (!this.options.complete) {
          return failure(
            request.id,
            JsonRpcErrorCode.MethodNotFound,
            "This server offers no completions",
          );
        }
        const values = this.options.complete(
          (params["ref"] ?? {}) as JsonObject,
          (params["argument"] ?? {}) as JsonObject,
        );
        return success(request.id, {
          completion: { values, total: values.length, hasMore: false },
        });
      }
      case McpMethod.LoggingSetLevel: {
        const level = params["level"];
        if (typeof level !== "string") {
          return failure(request.id, JsonRpcErrorCode.InvalidParams, "A level is required");
        }
        this.stats.logLevel = level;
        return success(request.id, {});
      }
      case McpMethod.PromptsList:
        return success(request.id, {
          prompts: this.prompts.map(
            ({ messages: _messages, ...prompt }) => prompt as unknown as JsonObject,
          ),
        });
      case McpMethod.PromptsGet: {
        const prompt = this.prompts.find(
          (candidate) => candidate.name === String(params["name"] ?? ""),
        );
        if (!prompt) {
          return failure(request.id, JsonRpcErrorCode.InvalidParams, "Unknown prompt");
        }
        return success(request.id, {
          ...(prompt.description ? { description: prompt.description } : {}),
          messages: prompt.messages ?? [],
        });
      }
      case McpMethod.ToolsCall:
        return this.callTool(request, introspection, stream);
      default:
        return failure(
          request.id,
          JsonRpcErrorCode.MethodNotFound,
          `Unsupported method: ${request.method}`,
        );
    }
  }

  private async callTool(
    request: JsonRpcRequest,
    introspection: TokenIntrospection,
    stream: ServerResponse | null,
  ): Promise<JsonRpcResponse> {
    this.stats.toolCalls += 1;
    const params = request.params ?? {};
    const name = String(params["name"] ?? "");
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return failure(request.id, JsonRpcErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const missing = missingScope(tool, introspection);
    if (missing) {
      return failure(
        request.id,
        JsonRpcErrorCode.InvalidRequest,
        `insufficient_scope: ${missing}`,
      );
    }

    const progressToken = (params["_meta"] as JsonObject | undefined)?.["progressToken"];
    const cancelled = new Promise<void>((resolve) => {
      this.cancelWaiters.set(request.id, resolve);
    });
    const hooks: ToolCallHooks = {
      streaming: stream !== null,
      cancelled,
      progress: (progress, total, message) => {
        if (!stream || progressToken === undefined) return;
        writeSseEvent(stream, {
          jsonrpc: JSONRPC_VERSION,
          method: McpMethod.Progress,
          params: {
            progressToken,
            progress,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          },
        });
      },
      request: async (method, requestParams) => {
        if (!stream) throw new Error("No stream is available for a server request");
        const id = this.nextServerRequestId;
        this.nextServerRequestId += 1;
        const answered = new Promise<JsonRpcResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingServerRequests.delete(id);
            reject(new Error("The client never answered the server request"));
          }, 10_000);
          this.pendingServerRequests.set(id, (response) => {
            clearTimeout(timer);
            resolve(response);
          });
        });
        writeSseEvent(stream, {
          jsonrpc: JSONRPC_VERSION,
          id,
          method,
          params: requestParams,
        });
        return answered;
      },
    };

    const args = (params["arguments"] ?? {}) as JsonObject;
    const handler =
      tool.handler ??
      ((): McpToolResult => ({
        content: [{ type: "text", text: `${tool.name} ok` }],
      }));
    try {
      const result = await handler(args, hooks);
      return success(request.id, result as unknown as JsonObject);
    } catch (error) {
      return failure(
        request.id,
        JsonRpcErrorCode.InternalError,
        (error as Error).message,
      );
    } finally {
      this.cancelWaiters.delete(request.id);
    }
  }
}

function missingScope(
  tool: MockToolDefinition,
  introspection: TokenIntrospection,
): string | null {
  if (!tool.requiredScope) return null;
  return introspection.scopes.includes(tool.requiredScope) ? null : tool.requiredScope;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    "id" in value &&
    (value as { id: unknown }).id !== undefined
  );
}

function isResponse(value: unknown): value is JsonRpcResponse & { id: string | number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    ("result" in value || "error" in value)
  );
}

function success(id: JsonRpcRequest["id"], result: JsonObject): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function failure(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

/** Monotonic across the process, which is all a client needs to resume from. */
let nextSseEventId = 1;

function writeSseEvent(res: ServerResponse, message: unknown): void {
  if (res.writableEnded) return;
  const id = nextSseEventId;
  nextSseEventId += 1;
  res.write(`id: ${id}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
}
