import {
  GatewayError,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  MCP_LOG_LEVELS,
  McpMethod,
  isMcpLogLevel,
  isRecord,
  jsonRpcFailure,
  jsonRpcSuccess,
  meetsLogLevel,
  toJsonObject,
  type Clock,
  type DiscoveredTool,
  type JsonObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpImplementation,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpLogLevel,
  type McpTool,
  type UpstreamConnection,
} from "@umg/core";
import type {
  DownstreamSessionHandle,
  McpServerHandler,
  RequestContext,
} from "@umg/mcp-server";
import type { UpstreamMcpConnection } from "@umg/mcp-client";
import { insufficientScopeFrom, type OAuthTokenManager } from "@umg/oauth";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import type { RateLimiter } from "@umg/security";
import type { GatewayStore } from "@umg/storage";

import type { AuditService } from "./audit.js";
import type { CatalogueChange } from "./connection-service.js";
import {
  namespaceResultResources,
  splitPromptName,
  splitResourceUri,
} from "./naming.js";
import { paginate, type Page } from "./pagination.js";
import type { PolicyEngine } from "./policy-engine.js";
import type {
  UpstreamMessageContext,
  UpstreamSessionManager,
} from "./upstream-sessions.js";

export interface GatewayHandlerDeps {
  store: GatewayStore;
  sessions: UpstreamSessionManager;
  tokenManager: OAuthTokenManager;
  /** Caps tool calls per tenant so one workspace cannot starve the others. */
  toolCallLimiter: RateLimiter;
  /** Caps every other MCP request per tenant, on the same budget as the API. */
  apiLimiter: RateLimiter;
  policy: PolicyEngine;
  audit: AuditService;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  serverInfo: McpImplementation;
  instructions?: string;
  /** Entries per page of `tools/list` and friends. */
  pageSize?: number;
  /** Resolves a live downstream session so upstream messages can be routed back. */
  lookupSession(sessionId: string): DownstreamSessionHandle | undefined;
  /** All live sessions for a tenant, used for list-changed fan-out. */
  sessionsForTenant(tenantId: string): DownstreamSessionHandle[];
  /**
   * Rediscovers one connection's catalogue, called when its upstream announces
   * that the catalogue moved. Supplied by the composition root rather than
   * imported, so the handler does not depend on the control plane it serves.
   */
  resyncCatalogue?(tenantId: string, connectionId: string): Promise<void>;
}

const LIST_CHANGED_METHODS = new Set<string>([
  McpMethod.ToolListChanged,
  McpMethod.ResourceListChanged,
  McpMethod.PromptListChanged,
]);

/** Large enough that most workspaces never paginate, small enough to stream. */
const DEFAULT_PAGE_SIZE = 100;

/** Shapes a page as the MCP list result the method expects. */
function page<T>(
  field: string,
  result: Page<T>,
  map: (item: T) => JsonObject = (item) => item as JsonObject,
): JsonObject {
  return {
    [field]: result.items.map(map),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  };
}

/**
 * Implements the MCP surface the gateway presents to Cursor, Claude Code,
 * Codex and any other client. Everything it returns is assembled from records
 * that were discovered at runtime from upstream servers.
 */
export class GatewayMcpHandler implements McpServerHandler {
  /**
   * Sinks for in-flight calls, keyed by session and progress token, so a
   * progress notification travels back on the stream that carries the call it
   * belongs to rather than the session's general notification channel.
   */
  private readonly progressSinks = new Map<
    string,
    (notification: JsonRpcNotification) => void
  >();

  /**
   * The log level each live upstream client has been told, so an upstream
   * opened after `logging/setLevel` is told once and one that was already open
   * is not told again on every call. Keyed by the client object, so a session
   * that is dropped and reopened is told afresh and nothing needs sweeping.
   */
  private readonly logLevelApplied = new WeakMap<UpstreamMcpConnection, McpLogLevel>();

  /**
   * Connections with a rediscovery already running, and whether another change
   * arrived while it ran. An upstream that rewrites its catalogue announces it
   * once per list, and three announcements should not mean three discoveries.
   */
  private readonly resyncing = new Map<string, { repeat: boolean }>();

  private readonly pageSize: number;

  constructor(private readonly deps: GatewayHandlerDeps) {
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async onInitialize(
    params: McpInitializeParams,
    session: DownstreamSessionHandle,
  ): Promise<McpInitializeResult> {
    // Sessions are the one thing a caller can create without asking for
    // anything, and each one costs memory and an upstream session per
    // connection it touches. Metering them on the same budget as the rest
    // stops one workspace from opening them without limit.
    this.deps.apiLimiter.require(session.tenantId, "MCP sessions");
    await this.deps.store.downstreamSessions.create({
      id: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      clientLabel: session.clientLabel,
      protocolVersion: session.protocolVersion,
      capabilitiesJson: toJsonObject(params.capabilities ?? {}),
      createdAt: this.deps.clock.now(),
      lastSeenAt: this.deps.clock.now(),
      status: "ACTIVE",
    });
    this.deps.logger.info("Downstream MCP session initialized", {
      tenantId: session.tenantId,
      sessionId: session.id,
      clientLabel: session.clientLabel,
      protocolVersion: session.protocolVersion,
    });
    const result: McpInitializeResult = {
      protocolVersion: session.protocolVersion || LATEST_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        completions: {},
        logging: {},
      },
      serverInfo: this.deps.serverInfo,
    };
    if (this.deps.instructions) result.instructions = this.deps.instructions;
    return result;
  }

  async onRequest(
    request: JsonRpcRequest,
    session: DownstreamSessionHandle,
    context: RequestContext,
  ): Promise<JsonObject> {
    const params = request.params ?? {};
    // Everything but a liveness check costs a database read at minimum and an
    // upstream round trip at worst, so the whole endpoint is metered, not only
    // the tool calls. `tools/call` is metered again, more tightly, below.
    if (request.method !== McpMethod.Ping) {
      this.deps.apiLimiter.require(session.tenantId, "MCP requests");
    }
    switch (request.method) {
      case McpMethod.Ping:
        return {};
      case McpMethod.ToolsList:
        return page(
          "tools",
          paginate(
            await this.listTools(session),
            (tool) => tool.name,
            params["cursor"],
            this.pageSize,
          ),
          toJsonObject,
        );
      case McpMethod.ToolsCall:
        return this.callTool(params, session, context);
      case McpMethod.ResourcesList:
        return page(
          "resources",
          paginate(
            await this.listResources(session, false),
            (resource) => String(resource["uri"]),
            params["cursor"],
            this.pageSize,
          ),
        );
      case McpMethod.ResourcesTemplatesList:
        return page(
          "resourceTemplates",
          paginate(
            await this.listResources(session, true),
            (template) => String(template["uriTemplate"]),
            params["cursor"],
            this.pageSize,
          ),
        );
      case McpMethod.ResourcesRead:
        return this.readResource(params, session);
      case McpMethod.ResourcesSubscribe:
        return this.resourceSubscription(params, session, true);
      case McpMethod.ResourcesUnsubscribe:
        return this.resourceSubscription(params, session, false);
      case McpMethod.PromptsList:
        return page(
          "prompts",
          paginate(
            await this.listPrompts(session),
            (prompt) => String(prompt["name"]),
            params["cursor"],
            this.pageSize,
          ),
        );
      case McpMethod.PromptsGet:
        return this.getPrompt(params, session);
      case McpMethod.CompletionComplete:
        return this.complete(params, session);
      case McpMethod.LoggingSetLevel:
        return this.setLogLevel(params, session);
      default:
        throw new GatewayError(
          "INVALID_REQUEST",
          `Unsupported method: ${request.method}`,
        );
    }
  }

  async onNotification(
    notification: JsonRpcNotification,
    session: DownstreamSessionHandle,
  ): Promise<void> {
    this.deps.logger.debug("Downstream notification", {
      method: notification.method,
      sessionId: session.id,
    });
    // The gateway tells every upstream it supports roots with `listChanged`,
    // so it owes them the notification when the client's roots move. When
    // policy withholds roots it never made that promise, and telling a server
    // its roots changed would only provoke a read it is not allowed.
    if (
      notification.method === McpMethod.RootsListChanged &&
      this.deps.policy.allowsServerRequest(McpMethod.RootsList)
    ) {
      await this.relayToUpstreams(session, McpMethod.RootsListChanged, {});
    }
  }

  /**
   * Applies a client's logging preference. The level is recorded so upstream
   * log notifications can be filtered on the way back, and pushed to the
   * upstreams themselves so the ones that honour it stop sending in the first
   * place. An upstream that has no logging capability is skipped rather than
   * asked and refused.
   */
  private async setLogLevel(
    params: JsonObject,
    session: DownstreamSessionHandle,
  ): Promise<JsonObject> {
    const level = params["level"];
    if (!isMcpLogLevel(level)) {
      throw new GatewayError(
        "INVALID_REQUEST",
        `logging/setLevel needs one of: ${MCP_LOG_LEVELS.join(", ")}`,
      );
    }
    session.setLogLevel(level);
    await Promise.all(
      this.deps.sessions
        .forDownstream(session.id)
        .map((client) => this.pushLogLevel(session, client)),
    );
    return {};
  }

  /**
   * Tells one upstream the level its downstream client asked for. Upstreams
   * that declare no logging capability are skipped rather than asked and
   * refused, and a failure is swallowed: the gateway filters on the way back
   * regardless, so the client's floor is honoured either way.
   */
  private async pushLogLevel(
    session: DownstreamSessionHandle,
    client: UpstreamMcpConnection,
  ): Promise<void> {
    const level = session.logLevel;
    if (level === null || !client.capabilities.logging) return;
    if (this.logLevelApplied.get(client) === level) return;
    this.logLevelApplied.set(client, level);
    try {
      await client.request(McpMethod.LoggingSetLevel, { level }, { idempotent: true });
    } catch (error) {
      this.logLevelApplied.delete(client);
      this.deps.logger.debug("Upstream would not accept the client's log level", {
        sessionId: session.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Opens or reuses the upstream session behind a connection and brings it in
   * line with anything the downstream client has already asked for.
   */
  private async upstreamFor(
    connection: UpstreamConnection,
    session: DownstreamSessionHandle,
  ): Promise<UpstreamMcpConnection> {
    const client = await this.deps.sessions.acquire(connection, session.id);
    await this.pushLogLevel(session, client);
    return client;
  }

  /** Best-effort fan-out of a client-side notification to this session's upstreams. */
  private async relayToUpstreams(
    session: DownstreamSessionHandle,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    await Promise.all(
      this.deps.sessions.forDownstream(session.id).map(async (client) => {
        // One unreachable upstream must not make the client's request fail;
        // the notification carries no result the caller is waiting on.
        try {
          await client.notify(method, params);
        } catch (error) {
          this.deps.logger.debug("Could not relay a client notification upstream", {
            method,
            sessionId: session.id,
            error: (error as Error).message,
          });
        }
      }),
    );
  }

  async onSessionClosed(session: DownstreamSessionHandle): Promise<void> {
    await this.deps.sessions.releaseDownstream(session.id);
    await this.deps.store.downstreamSessions.close(session.id);
  }

  /** Announces catalogue changes to every live session of a tenant. */
  notifyCatalogueChanged(tenantId: string, changed: CatalogueChange): void {
    if (changed.tools) this.broadcast(tenantId, McpMethod.ToolListChanged);
    if (changed.resources) this.broadcast(tenantId, McpMethod.ResourceListChanged);
    if (changed.prompts) this.broadcast(tenantId, McpMethod.PromptListChanged);
  }

  private broadcast(tenantId: string, method: string): void {
    const notification: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method };
    for (const session of this.deps.sessionsForTenant(tenantId)) {
      session.sendNotification(notification);
    }
  }

  /**
   * Rediscovers a connection's catalogue in the background, at most one at a
   * time per connection. A change announced while a discovery is running is
   * not necessarily visible to it, so one more run is queued rather than
   * dropped.
   */
  private scheduleResync(context: UpstreamMessageContext): void {
    const resync = this.deps.resyncCatalogue;
    if (!resync) return;

    const running = this.resyncing.get(context.connectionId);
    if (running) {
      running.repeat = true;
      return;
    }

    const state = { repeat: false };
    this.resyncing.set(context.connectionId, state);
    void (async () => {
      do {
        state.repeat = false;
        try {
          await resync(context.tenantId, context.connectionId);
        } catch (error) {
          // A failed rediscovery leaves the previous catalogue in place, which
          // is stale but usable; the periodic worker sync tries again.
          this.deps.logger.warn("Rediscovery after an upstream change failed", {
            connectionId: context.connectionId,
            alias: context.alias,
            error: (error as Error).message,
          });
        }
      } while (state.repeat);
    })().finally(() => {
      this.resyncing.delete(context.connectionId);
    });
  }

  /**
   * Forwards a notification that arrived on an upstream session to the single
   * downstream session responsible for it. Notifications are never broadcast
   * across sessions.
   */
  routeUpstreamNotification(
    context: UpstreamMessageContext,
    notification: JsonRpcNotification,
  ): void {
    // A catalogue change concerns everyone connected to this tenant, not just
    // the session that happened to be holding the upstream connection open.
    if (LIST_CHANGED_METHODS.has(notification.method)) {
      // Forwarding alone would tell clients to re-read a catalogue the gateway
      // has not re-read itself, so they would fetch the same stale list. The
      // rediscovery announces its own diff once it lands.
      this.scheduleResync(context);
      this.broadcast(context.tenantId, notification.method);
      return;
    }
    if (notification.method === McpMethod.Progress) {
      const token = notification.params?.["progressToken"];
      const sink = this.progressSinks.get(
        progressKey(context.downstreamSessionId, token),
      );
      if (sink) {
        sink(notification);
        return;
      }
    }
    const session = this.deps.lookupSession(context.downstreamSessionId);
    if (!session) return;
    if (
      notification.method === McpMethod.LoggingMessage &&
      session.logLevel !== null &&
      !meetsLogLevel(notification.params?.["level"], session.logLevel)
    ) {
      // The client asked for a floor and some upstreams ignore it, so the
      // gateway enforces it rather than passing the noise straight through.
      return;
    }
    if (notification.method === McpMethod.ResourceUpdated) {
      const uri = notification.params?.["uri"];
      if (typeof uri === "string") {
        session.sendNotification({
          ...notification,
          params: { ...notification.params, uri: `${context.alias}+${uri}` },
        });
        return;
      }
    }
    session.sendNotification(notification);
  }

  /**
   * Routes an upstream server-to-client request to the downstream session that
   * triggered it, after checking gateway policy and client capabilities.
   */
  async routeUpstreamRequest(
    context: UpstreamMessageContext,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    if (!this.deps.policy.allowsServerRequest(request.method)) {
      return jsonRpcFailure(
        request.id,
        JsonRpcErrorCode.PolicyDenied,
        `Gateway policy does not allow ${request.method}`,
      );
    }
    const session = this.deps.lookupSession(context.downstreamSessionId);
    if (!session) {
      return jsonRpcFailure(
        request.id,
        JsonRpcErrorCode.MethodNotFound,
        "No downstream client is attached to this upstream session",
      );
    }
    const supported =
      (request.method.startsWith("sampling/") && session.capabilities.sampling) ||
      (request.method.startsWith("elicitation/") && session.capabilities.elicitation) ||
      (request.method.startsWith("roots/") && session.capabilities.roots);
    if (!supported) {
      return jsonRpcFailure(
        request.id,
        JsonRpcErrorCode.MethodNotFound,
        `The connected client does not support ${request.method}`,
      );
    }
    try {
      const result = await session.sendRequest(request.method, request.params ?? {});
      return jsonRpcSuccess(request.id, result);
    } catch (error) {
      return jsonRpcFailure(
        request.id,
        JsonRpcErrorCode.InternalError,
        (error as Error).message,
      );
    }
  }

  private async listTools(session: DownstreamSessionHandle): Promise<McpTool[]> {
    const connections = await this.visibleConnections(session);
    const usable = new Set(connections.map((connection) => connection.id));
    const tools = await this.deps.store.tools.listByTenant(session.tenantId);
    return tools
      .filter((tool) => tool.enabled && usable.has(tool.connectionId))
      .map((tool) => {
        const descriptor: McpTool = {
          name: tool.gatewayName,
          inputSchema: tool.inputSchemaJson,
        };
        if (tool.description) descriptor.description = tool.description;
        if (tool.outputSchemaJson) descriptor.outputSchema = tool.outputSchemaJson;
        if (tool.annotationsJson) descriptor.annotations = tool.annotationsJson;
        return descriptor;
      });
  }

  private async callTool(
    params: JsonObject,
    session: DownstreamSessionHandle,
    context: RequestContext,
  ): Promise<JsonObject> {
    const name = params["name"];
    if (typeof name !== "string") {
      throw new GatewayError("INVALID_REQUEST", "tools/call requires a tool name");
    }
    this.deps.toolCallLimiter.require(session.tenantId, "tool calls");
    const args = params["arguments"] ?? {};
    const started = this.deps.clock.now();

    const tool = await this.deps.store.tools.findByGatewayName(session.tenantId, name);
    if (!tool) {
      throw new GatewayError("NOT_FOUND", `Unknown tool: ${name}`);
    }
    const connection = await this.requireVisibleConnection(session, tool.connectionId);

    const decision = this.deps.policy.evaluateToolCall({
      tool,
      connection,
      args,
      roles: session.roles,
    });
    if (decision.outcome === "DENY" || decision.outcome === "INVALID_ARGUMENTS") {
      await this.audit(session, tool, connection, "tools/call", args, "DENIED", started, {
        reason: decision.reason ?? "denied",
      });
      throw decision.outcome === "INVALID_ARGUMENTS"
        ? new GatewayError("INVALID_REQUEST", decision.reason ?? "Invalid arguments")
        : new GatewayError("POLICY_DENIED", decision.reason ?? "Blocked by policy");
    }
    if (decision.outcome === "REQUIRE_CONFIRMATION") {
      const confirmed = await this.confirm(session, tool);
      this.deps.metrics.counter(Metric.DestructiveToolConfirmation, {
        outcome: confirmed ? "accepted" : "declined",
      });
      if (!confirmed) {
        await this.audit(
          session,
          tool,
          connection,
          "tools/call",
          args,
          "DENIED",
          started,
          { reason: "confirmation_required" },
        );
        throw new GatewayError(
          "POLICY_DENIED",
          `${tool.gatewayName} is classified ${tool.riskLevel} and needs confirmation. ` +
            "Approve it in the gateway control plane or use a client that supports elicitation.",
        );
      }
    }

    this.deps.metrics.counter(Metric.McpToolCall, { alias: connection.alias });
    const progressToken = readProgressToken(params);
    if (progressToken !== undefined) {
      this.progressSinks.set(progressKey(session.id, progressToken), (notification) => {
        context.sendNotification(notification);
      });
    }
    try {
      const client = await this.upstreamFor(connection, session);
      const result = await client.callTool(tool.upstreamName, args, {
        idempotent: tool.riskLevel === "READ_ONLY",
        signal: context.signal,
        ...(progressToken === undefined ? {} : { progressToken }),
      });
      this.deps.policy.assertResultWithinLimits(result);
      this.deps.metrics.observe(
        Metric.McpToolCallDuration,
        this.deps.clock.now() - started,
        { alias: connection.alias },
      );
      await this.audit(session, tool, connection, "tools/call", args, "OK", started);
      return namespaceResultResources(toJsonObject(result), connection.alias);
    } catch (error) {
      this.deps.metrics.counter(Metric.McpToolCallFailed, { alias: connection.alias });
      await this.audit(
        session,
        tool,
        connection,
        "tools/call",
        args,
        "ERROR",
        started,
        { error: (error as Error).message },
      );
      // A token that authorized the connection can still be too narrow for one
      // tool. That is not a broken grant, it is a grant that has to be widened,
      // so the user gets a reconnect link rather than an opaque failure.
      const required = insufficientScopeFrom(error);
      if (required !== null) {
        await this.deps.tokenManager.requireIncrementalAuthorization(
          { tenantId: connection.tenantId, connectionId: connection.id },
          [...new Set([...connection.grantedScopes, ...required])],
        );
      }
      throw error;
    } finally {
      if (progressToken !== undefined) {
        this.progressSinks.delete(progressKey(session.id, progressToken));
      }
    }
  }

  private async confirm(
    session: DownstreamSessionHandle,
    tool: DiscoveredTool,
  ): Promise<boolean> {
    if (!session.capabilities.elicitation) return false;
    try {
      const response = await session.sendRequest(McpMethod.ElicitationCreate, {
        message:
          `The gateway classified ${tool.gatewayName} as ${tool.riskLevel}. ` +
          "Confirm that you want to run it.",
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Run this tool",
            },
          },
          required: ["confirm"],
        },
      });
      const content = response["content"];
      return (
        response["action"] === "accept" &&
        isRecord(content) &&
        content["confirm"] === true
      );
    } catch (error) {
      this.deps.logger.warn("Confirmation request failed", {
        tool: tool.gatewayName,
        error: (error as Error).message,
      });
      return false;
    }
  }

  private async listResources(
    session: DownstreamSessionHandle,
    templates: boolean,
  ): Promise<JsonObject[]> {
    const connections = await this.visibleConnections(session);
    const usable = new Set(connections.map((connection) => connection.id));
    const resources = await this.deps.store.resources.listByTenant(session.tenantId);
    return resources
      .filter(
        (resource) => usable.has(resource.connectionId) && resource.isTemplate === templates,
      )
      .map((resource) => {
        const descriptor: JsonObject = templates
          ? { uriTemplate: resource.gatewayUri, name: resource.name }
          : { uri: resource.gatewayUri, name: resource.name };
        if (resource.description) descriptor["description"] = resource.description;
        if (resource.mimeType) descriptor["mimeType"] = resource.mimeType;
        return descriptor;
      });
  }

  private async readResource(
    params: JsonObject,
    session: DownstreamSessionHandle,
  ): Promise<JsonObject> {
    const uri = params["uri"];
    if (typeof uri !== "string") {
      throw new GatewayError("INVALID_REQUEST", "resources/read requires a uri");
    }
    const record = await this.deps.store.resources.findByGatewayUri(
      session.tenantId,
      uri,
    );
    const routed = record
      ? { connectionId: record.connectionId, upstreamUri: record.upstreamUri }
      : await this.routeByAlias(session, uri);
    const connection = await this.requireVisibleConnection(session, routed.connectionId);
    const client = await this.upstreamFor(connection, session);
    const contents = await client.readResource(routed.upstreamUri);
    return namespaceResultResources(toJsonObject(contents), connection.alias);
  }

  private async resourceSubscription(
    params: JsonObject,
    session: DownstreamSessionHandle,
    subscribe: boolean,
  ): Promise<JsonObject> {
    const uri = params["uri"];
    if (typeof uri !== "string") {
      throw new GatewayError("INVALID_REQUEST", "A resource uri is required");
    }
    const record = await this.deps.store.resources.findByGatewayUri(
      session.tenantId,
      uri,
    );
    const routed = record
      ? { connectionId: record.connectionId, upstreamUri: record.upstreamUri }
      : await this.routeByAlias(session, uri);
    const connection = await this.requireVisibleConnection(session, routed.connectionId);
    const client = await this.upstreamFor(connection, session);
    if (subscribe) await client.subscribeResource(routed.upstreamUri);
    else await client.unsubscribeResource(routed.upstreamUri);
    return {};
  }

  private async listPrompts(session: DownstreamSessionHandle): Promise<JsonObject[]> {
    const connections = await this.visibleConnections(session);
    const usable = new Set(connections.map((connection) => connection.id));
    const prompts = await this.deps.store.prompts.listByTenant(session.tenantId);
    return prompts
      .filter((prompt) => usable.has(prompt.connectionId))
      .map((prompt) => {
        const descriptor: JsonObject = { name: prompt.gatewayName };
        if (prompt.description) descriptor["description"] = prompt.description;
        const args = prompt.argumentsJson?.["arguments"];
        if (Array.isArray(args)) descriptor["arguments"] = args;
        return descriptor;
      });
  }

  private async getPrompt(
    params: JsonObject,
    session: DownstreamSessionHandle,
  ): Promise<JsonObject> {
    const name = params["name"];
    if (typeof name !== "string") {
      throw new GatewayError("INVALID_REQUEST", "prompts/get requires a name");
    }
    const record = await this.deps.store.prompts.findByGatewayName(
      session.tenantId,
      name,
    );
    if (!record) throw new GatewayError("NOT_FOUND", `Unknown prompt: ${name}`);
    const connection = await this.requireVisibleConnection(session, record.connectionId);
    const client = await this.upstreamFor(connection, session);
    const result = await client.getPrompt(record.upstreamName, params["arguments"] ?? {});
    return namespaceResultResources(toJsonObject(result), connection.alias);
  }

  /**
   * Completes an argument of a prompt or a resource template. The reference
   * the client sends names the gateway's version of the prompt or template, so
   * it identifies the upstream that owns it; the reference is rewritten to the
   * upstream's own name before being forwarded.
   */
  private async complete(
    params: JsonObject,
    session: DownstreamSessionHandle,
  ): Promise<JsonObject> {
    const ref = params["ref"];
    if (!isRecord(ref)) {
      throw new GatewayError("INVALID_REQUEST", "completion/complete requires a ref");
    }
    const routed = await this.routeCompletionRef(ref, session);
    const connection = await this.requireVisibleConnection(session, routed.connectionId);
    const client = await this.upstreamFor(connection, session);
    if (!client.capabilities.completions) {
      // The upstream owns this prompt but offers no completions. An empty set
      // is the specification's answer for "nothing to suggest", and it keeps
      // one incapable upstream from failing a client's keystroke.
      return { completion: { values: [], total: 0, hasMore: false } };
    }
    return client.request(
      McpMethod.CompletionComplete,
      { ...params, ref: routed.ref },
      { idempotent: true },
    );
  }

  private async routeCompletionRef(
    ref: Record<string, unknown>,
    session: DownstreamSessionHandle,
  ): Promise<{ connectionId: string; ref: JsonObject }> {
    if (ref["type"] === "ref/prompt") {
      const name = ref["name"];
      if (typeof name !== "string") {
        throw new GatewayError("INVALID_REQUEST", "A prompt reference requires a name");
      }
      const record = await this.deps.store.prompts.findByGatewayName(
        session.tenantId,
        name,
      );
      if (!record) throw new GatewayError("NOT_FOUND", `Unknown prompt: ${name}`);
      return {
        connectionId: record.connectionId,
        ref: { ...ref, name: record.upstreamName } as JsonObject,
      };
    }
    if (ref["type"] === "ref/resource") {
      const uri = ref["uri"];
      if (typeof uri !== "string") {
        throw new GatewayError("INVALID_REQUEST", "A resource reference requires a uri");
      }
      const record = await this.deps.store.resources.findByGatewayUri(
        session.tenantId,
        uri,
      );
      const target = record
        ? { connectionId: record.connectionId, upstreamUri: record.upstreamUri }
        : await this.routeByAlias(session, uri);
      return {
        connectionId: target.connectionId,
        ref: { ...ref, uri: target.upstreamUri } as JsonObject,
      };
    }
    throw new GatewayError(
      "INVALID_REQUEST",
      `Unsupported completion reference: ${String(ref["type"])}`,
    );
  }

  /** Falls back to alias routing for resource URIs that were never listed. */
  private async routeByAlias(
    session: DownstreamSessionHandle,
    gatewayUri: string,
  ): Promise<{ connectionId: string; upstreamUri: string }> {
    const split = splitResourceUri(gatewayUri) ?? splitPromptName(gatewayUri);
    if (!split) {
      throw new GatewayError("NOT_FOUND", `Unknown resource: ${gatewayUri}`);
    }
    const alias = "alias" in split ? split.alias : "";
    const connection = await this.deps.store.connections.findByAlias(
      session.tenantId,
      alias,
    );
    if (!connection) {
      throw new GatewayError("NOT_FOUND", `Unknown resource: ${gatewayUri}`);
    }
    return {
      connectionId: connection.id,
      upstreamUri: "upstreamUri" in split ? split.upstreamUri : split.upstreamName,
    };
  }

  /**
   * The connections this session may be served from. A disabled connection is
   * not one of them: it is excluded here rather than at each call site, so a
   * new MCP method cannot forget to check.
   */
  private async visibleConnections(
    session: DownstreamSessionHandle,
  ): Promise<UpstreamConnection[]> {
    const connections = await this.deps.store.connections.listVisible(
      session.tenantId,
      session.userId,
    );
    return connections.filter((connection) => connection.status !== "DISABLED");
  }

  private async requireVisibleConnection(
    session: DownstreamSessionHandle,
    connectionId: string,
  ): Promise<UpstreamConnection> {
    const connections = await this.visibleConnections(session);
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection) {
      this.deps.metrics.counter(Metric.TenantAccessDenied, { stage: "tool_routing" });
      throw new GatewayError("FORBIDDEN", "This connection is not available to you");
    }
    return connection;
  }

  private async audit(
    session: DownstreamSessionHandle,
    tool: DiscoveredTool,
    connection: UpstreamConnection,
    operation: string,
    args: unknown,
    resultStatus: "OK" | "ERROR" | "DENIED",
    started: number,
    detail?: JsonObject,
  ): Promise<void> {
    await this.deps.audit.record({
      tenantId: session.tenantId,
      userId: session.userId,
      downstreamSessionId: session.id,
      connectionId: connection.id,
      toolId: tool.id,
      operation,
      input: args,
      resultStatus,
      durationMs: this.deps.clock.now() - started,
      detail: {
        gatewayTool: tool.gatewayName,
        upstreamTool: tool.upstreamName,
        schemaHash: tool.schemaHash,
        riskLevel: tool.riskLevel,
        ...(detail ?? {}),
      },
    });
  }
}

function progressKey(sessionId: string, token: unknown): string {
  return `${sessionId}:${String(token)}`;
}

function readProgressToken(params: JsonObject): string | number | undefined {
  const meta = params["_meta"];
  if (!isRecord(meta)) return undefined;
  const token = meta["progressToken"];
  if (typeof token === "string" || typeof token === "number") return token;
  return undefined;
}
