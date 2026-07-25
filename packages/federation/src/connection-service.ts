import {
  GatewayError,
  clampText,
  newId,
  schemaHash,
  toJsonObject,
  uniqueStrings,
  type Clock,
  type ConnectionOwnerType,
  type DiscoveredPrompt,
  type DiscoveredResource,
  type DiscoveredTool,
  type JsonObject,
  type McpImplementation,
  type McpServerRecord,
  type UpstreamConnection,
} from "@umg/core";
import { probeMcpEndpoint } from "@umg/mcp-client";
import {
  parseWwwAuthenticate,
  selectBearerChallenge,
  type GatewayIdentity,
  type OAuthDiscoveryService,
  type OAuthTokenManager,
  type RegistrationSelector,
} from "@umg/oauth";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import { canonicalizeUrl, type CredentialVault, type SafeFetcher } from "@umg/security";
import type { GatewayStore, ToolSyncResult } from "@umg/storage";

import type { AuditService } from "./audit.js";
import {
  defaultAliasFor,
  gatewayPromptName,
  gatewayResourceUri,
  gatewayToolName,
  isValidAlias,
  sanitizeAlias,
} from "./naming.js";
import type { PolicyEngine } from "./policy-engine.js";
import { classifyTool } from "./tool-classifier.js";
import { CATALOGUE_SESSION } from "./upstream-sessions.js";
import type { UpstreamSessionManager } from "./upstream-sessions.js";

export interface ConnectionServiceDeps {
  store: GatewayStore;
  vault: CredentialVault;
  fetcher: SafeFetcher;
  discovery: OAuthDiscoveryService;
  registrations: RegistrationSelector;
  tokenManager: OAuthTokenManager;
  sessions: UpstreamSessionManager;
  policy: PolicyEngine;
  audit: AuditService;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  identity: GatewayIdentity;
  clientInfo: McpImplementation;
  allowHttp: boolean;
  onCatalogueChanged?(tenantId: string, connectionId: string): void;
}

export interface CreateConnectionInput {
  tenantId: string;
  userId: string;
  mcpUrl: string;
  alias?: string;
  displayName?: string;
  ownerType?: ConnectionOwnerType;
  /** Generic secret headers for MCP servers that do not implement OAuth. */
  staticHeaders?: Record<string, string>;
}

export interface ConnectionView {
  connectionId: string;
  alias: string;
  status: UpstreamConnection["status"];
  mcpUrl: string;
  displayName: string;
  serverName: string | null;
  toolCount: number;
  lastError: string | null;
  authorizationUrl?: string;
}

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  async createConnection(input: CreateConnectionInput): Promise<ConnectionView> {
    const canonicalUrl = canonicalizeUrl(input.mcpUrl, {
      allowHttp: this.deps.allowHttp,
    });

    const existingServer = await this.deps.store.mcpServers.findByCanonicalUrl(
      input.tenantId,
      canonicalUrl,
    );
    if (existingServer) {
      const connections = await this.deps.store.connections.listByTenant(input.tenantId);
      const existing = connections.find(
        (connection) => connection.mcpServerId === existingServer.id,
      );
      if (existing) return this.view(existing);
    }

    const probe = await probeMcpEndpoint({
      url: canonicalUrl,
      fetcher: this.deps.fetcher,
      logger: this.deps.logger,
      metrics: this.deps.metrics,
      clientInfo: this.deps.clientInfo,
      ...(input.staticHeaders
        ? { authHeaders: async () => input.staticHeaders as Record<string, string> }
        : {}),
    });

    const now = this.deps.clock.now();
    const server: McpServerRecord =
      existingServer ??
      (await this.deps.store.mcpServers.create({
        id: newId("srv"),
        tenantId: input.tenantId,
        canonicalUrl,
        originalUrl: input.mcpUrl,
        displayName:
          input.displayName ??
          probe.initializeResult?.serverInfo?.name ??
          new URL(canonicalUrl).host,
        authorizationRequired: probe.authorizationRequired,
        protectedResourceMetadataUrl: null,
        canonicalResource: canonicalUrl,
        selectedAuthorizationServer: null,
        transportType: probe.transportType,
        protocolVersion: probe.initializeResult?.protocolVersion ?? null,
        capabilitiesJson: probe.initializeResult
          ? toJsonObject(probe.initializeResult.capabilities)
          : null,
        metadataJson: null,
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      }));

    const taken = (await this.deps.store.connections.listByTenant(input.tenantId)).map(
      (connection) => connection.alias,
    );
    const requested = input.alias ? sanitizeAlias(input.alias) : null;
    const alias =
      requested && !taken.includes(requested)
        ? requested
        : defaultAliasFor(canonicalUrl, taken);
    if (!isValidAlias(alias)) {
      throw new GatewayError("INVALID_REQUEST", `Invalid alias: ${alias}`);
    }

    const connection = await this.deps.store.connections.create({
      id: newId("conn"),
      tenantId: input.tenantId,
      ownerType: input.ownerType ?? "USER",
      ownerId: input.ownerType === "WORKSPACE" ? input.tenantId : input.userId,
      mcpServerId: server.id,
      oauthIssuerId: null,
      oauthClientRegistrationId: null,
      alias,
      grantedScopes: [],
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      staticHeadersEncrypted: input.staticHeaders
        ? await this.deps.vault.encrypt(
            { tenantId: input.tenantId, purpose: "static_headers" },
            JSON.stringify(input.staticHeaders),
          )
        : null,
      tokenType: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      tokenVersion: 1,
      dpopKeyReference: null,
      status: probe.authorizationRequired ? "AUTHORIZATION_REQUIRED" : "CONNECTED",
      lastRefreshAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastErrorMessageRedacted: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.deps.audit.record({
      tenantId: input.tenantId,
      userId: input.userId,
      connectionId: connection.id,
      operation: "connection.create",
      resultStatus: "OK",
      detail: { alias, canonicalUrl, authorizationRequired: probe.authorizationRequired },
    });

    if (!probe.authorizationRequired) {
      await this.syncCatalogue(connection);
      return this.view(await this.reload(connection));
    }

    const prepared = await this.prepareAuthorization({
      connection,
      server,
      userId: input.userId,
      wwwAuthenticate: probe.wwwAuthenticate ?? null,
    });
    return { ...(await this.view(await this.reload(connection))), ...prepared };
  }

  /** Builds a fresh authorization URL for a pending or expired connection. */
  async startAuthorization(params: {
    tenantId: string;
    userId: string;
    connectionId: string;
    returnTo?: string | null;
  }): Promise<{ authorizationUrl: string }> {
    const connection = await this.requireConnection(params.tenantId, params.connectionId);
    const server = await this.requireServer(connection);
    const prepared = await this.prepareAuthorization({
      connection,
      server,
      userId: params.userId,
      wwwAuthenticate: null,
      returnTo: params.returnTo ?? null,
    });
    if (!prepared.authorizationUrl) {
      throw new GatewayError(
        "CLIENT_CREDENTIALS_REQUIRED",
        "This authorization server requires an OAuth client ID.",
      );
    }
    return { authorizationUrl: prepared.authorizationUrl };
  }

  /**
   * Runs discovery, selects a client registration mechanism and creates the
   * PKCE transaction. Every step is generic: nothing here knows which product
   * sits behind the MCP endpoint.
   */
  private async prepareAuthorization(params: {
    connection: UpstreamConnection;
    server: McpServerRecord;
    userId: string;
    wwwAuthenticate: string | null;
    returnTo?: string | null;
  }): Promise<{ authorizationUrl?: string }> {
    const { connection, server } = params;
    const challenge = selectBearerChallenge(
      parseWwwAuthenticate(params.wwwAuthenticate ?? undefined),
    );

    const resourceDiscovery = await this.deps.discovery.discoverProtectedResource(
      server.canonicalUrl,
      challenge,
    );
    const authorizationServers = resourceDiscovery.metadata.authorization_servers ?? [];
    const issuer =
      server.selectedAuthorizationServer &&
      authorizationServers.includes(server.selectedAuthorizationServer)
        ? server.selectedAuthorizationServer
        : authorizationServers[0];
    if (!issuer) {
      throw new GatewayError(
        "DISCOVERY_FAILED",
        "The MCP server advertises no authorization server",
      );
    }

    const { record: issuerRecord, metadata } =
      await this.deps.discovery.discoverAuthorizationServer(issuer);

    // Credentials are bound to the issuer: if the resource moved to another
    // authorization server the old grant must not be reused.
    if (
      connection.oauthIssuerId !== null &&
      connection.oauthIssuerId !== issuerRecord.id
    ) {
      await this.deps.store.connections.update(connection.id, {
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        oauthClientRegistrationId: null,
        tokenVersion: connection.tokenVersion + 1,
      });
    }

    await this.deps.store.mcpServers.update(server.tenantId, server.id, {
      authorizationRequired: true,
      protectedResourceMetadataUrl: resourceDiscovery.metadataUrl,
      canonicalResource: resourceDiscovery.metadata.resource,
      selectedAuthorizationServer: issuerRecord.issuer,
      metadataJson: toJsonObject(resourceDiscovery.metadata),
    });

    const scopes = uniqueStrings([
      ...(challenge?.params["scope"]?.split(" ") ?? []),
      ...(resourceDiscovery.metadata.scopes_supported ?? []),
    ]).filter((scope) => scope.length > 0);

    const registration = await this.deps.registrations
      .resolve({
        tenantId: connection.tenantId,
        issuerRecord,
        metadata,
        redirectUri: this.deps.identity.redirectUri,
        requestedScopes: scopes,
      })
      .catch(async (error: unknown) => {
        if (
          error instanceof GatewayError &&
          error.code === "CLIENT_CREDENTIALS_REQUIRED"
        ) {
          await this.deps.store.connections.update(connection.id, {
            oauthIssuerId: issuerRecord.id,
            status: "CLIENT_CREDENTIALS_REQUIRED",
            lastErrorCode: "client_credentials_required",
            lastErrorMessageRedacted:
              "This authorization server requires an OAuth client ID.",
          });
        }
        throw error;
      });

    await this.deps.store.connections.update(connection.id, {
      oauthIssuerId: issuerRecord.id,
      oauthClientRegistrationId: registration.registrationId,
      status: "AUTHORIZATION_REQUIRED",
    });

    const transaction = await this.deps.tokenManager.createAuthorizationTransaction({
      tenantId: connection.tenantId,
      userId: params.userId,
      connectionId: connection.id,
      issuerRecord,
      metadata,
      registration,
      scopes,
      resource: resourceDiscovery.metadata.resource,
      returnTo: params.returnTo ?? null,
    });
    return { authorizationUrl: transaction.authorizationUrl };
  }

  /** Called after a successful OAuth callback to bring the catalogue online. */
  async activateConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<ToolSyncResult> {
    const connection = await this.requireConnection(tenantId, connectionId);
    await this.detectTransport(connection);
    return this.syncCatalogue(connection);
  }

  /**
   * Re-probes an authorized endpoint. Before authorization every transport
   * answers with the same 401, so the transport and capabilities recorded at
   * creation time are only a guess; this is the first moment the gateway can
   * observe what the server actually speaks.
   */
  private async detectTransport(connection: UpstreamConnection): Promise<void> {
    const server = await this.requireServer(connection);
    const probe = await probeMcpEndpoint({
      url: server.canonicalUrl,
      fetcher: this.deps.fetcher,
      logger: this.deps.logger,
      metrics: this.deps.metrics,
      clientInfo: this.deps.clientInfo,
      authHeaders: () =>
        this.deps.tokenManager.authorizationHeaders({
          tenantId: connection.tenantId,
          connectionId: connection.id,
        }),
    }).catch(() => null);
    if (!probe?.initializeResult) return;
    await this.deps.store.mcpServers.update(server.tenantId, server.id, {
      transportType: probe.transportType,
      protocolVersion: probe.initializeResult.protocolVersion,
      capabilitiesJson: toJsonObject(probe.initializeResult.capabilities),
      displayName:
        server.displayName === new URL(server.canonicalUrl).host
          ? (probe.initializeResult.serverInfo?.name ?? server.displayName)
          : server.displayName,
    });
  }

  /**
   * Rediscovers tools, resources and prompts. Discovery failures degrade a
   * single connection instead of taking down the whole gateway.
   */
  async syncCatalogue(connection: UpstreamConnection): Promise<ToolSyncResult> {
    const started = this.deps.clock.now();
    try {
      const client = await this.deps.sessions.acquire(connection, CATALOGUE_SESSION);
      const [tools, resources, templates, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listResourceTemplates(),
        client.listPrompts(),
      ]);

      const takenNames = new Set<string>();
      const toolRecords: DiscoveredTool[] = tools.map((tool) => {
        const gatewayName = gatewayToolName(connection.alias, tool.name, takenNames);
        takenNames.add(gatewayName);
        const annotations = tool.annotations ? toJsonObject(tool.annotations) : null;
        const riskLevel = classifyTool(tool.name, tool.description ?? null, annotations);
        return {
          id: newId("tool"),
          tenantId: connection.tenantId,
          connectionId: connection.id,
          upstreamName: tool.name,
          gatewayName,
          description: tool.description ?? null,
          inputSchemaJson: toJsonObject(tool.inputSchema ?? { type: "object" }),
          outputSchemaJson: tool.outputSchema ? toJsonObject(tool.outputSchema) : null,
          annotationsJson: annotations,
          schemaHash: schemaHash({
            input: tool.inputSchema ?? null,
            output: tool.outputSchema ?? null,
            description: tool.description ?? null,
          }),
          enabled: this.deps.policy.shouldExposeTool(riskLevel, annotations),
          riskLevel,
          discoveredAt: started,
          lastSeenAt: started,
        };
      });

      const resourceRecords: DiscoveredResource[] = [
        ...resources.map((resource) => ({
          id: newId("res"),
          tenantId: connection.tenantId,
          connectionId: connection.id,
          upstreamUri: resource.uri,
          gatewayUri: gatewayResourceUri(connection.alias, resource.uri),
          name: resource.name,
          description: resource.description ?? null,
          mimeType: resource.mimeType ?? null,
          isTemplate: false,
          lastSeenAt: started,
        })),
        ...templates.map((template) => ({
          id: newId("res"),
          tenantId: connection.tenantId,
          connectionId: connection.id,
          upstreamUri: template.uriTemplate,
          gatewayUri: gatewayResourceUri(connection.alias, template.uriTemplate),
          name: template.name,
          description: template.description ?? null,
          mimeType: template.mimeType ?? null,
          isTemplate: true,
          lastSeenAt: started,
        })),
      ];

      const promptRecords: DiscoveredPrompt[] = prompts.map((prompt) => ({
        id: newId("prm"),
        tenantId: connection.tenantId,
        connectionId: connection.id,
        upstreamName: prompt.name,
        gatewayName: gatewayPromptName(connection.alias, prompt.name),
        description: prompt.description ?? null,
        argumentsJson: prompt.arguments
          ? ({ arguments: prompt.arguments } as unknown as JsonObject)
          : null,
        lastSeenAt: started,
      }));

      const sync = await this.deps.store.tools.sync(connection.id, toolRecords, started);
      await this.deps.store.resources.sync(connection.id, resourceRecords);
      await this.deps.store.prompts.sync(connection.id, promptRecords);

      if (sync.changed.length > 0) {
        this.deps.metrics.counter(Metric.McpToolSchemaChanged, {
          alias: connection.alias,
        });
      }

      await this.deps.store.connections.update(connection.id, {
        status:
          connection.status === "CONNECTED_NON_REFRESHABLE"
            ? "CONNECTED_NON_REFRESHABLE"
            : "CONNECTED",
        lastSuccessAt: this.deps.clock.now(),
        lastErrorCode: null,
        lastErrorMessageRedacted: null,
      });

      if (sync.added.length + sync.removed.length + sync.changed.length > 0) {
        this.deps.onCatalogueChanged?.(connection.tenantId, connection.id);
      }
      return sync;
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError
          ? error
          : new GatewayError("UPSTREAM_UNAVAILABLE", (error as Error).message);
      await this.deps.store.connections.update(connection.id, {
        status:
          gatewayError.code === "AUTHORIZATION_REQUIRED"
            ? "REAUTH_REQUIRED"
            : "DEGRADED",
        lastErrorCode: gatewayError.code,
        lastErrorMessageRedacted: clampText(gatewayError.message, 200),
      });
      this.deps.logger.warn("Catalogue discovery failed", {
        connectionId: connection.id,
        alias: connection.alias,
        code: gatewayError.code,
      });
      throw gatewayError;
    }
  }

  async refreshAllCatalogues(tenantId: string): Promise<void> {
    const connections = await this.deps.store.connections.listByTenant(tenantId);
    for (const connection of connections) {
      if (connection.status !== "CONNECTED") continue;
      await this.syncCatalogue(connection).catch(() => undefined);
    }
  }

  async rename(
    tenantId: string,
    connectionId: string,
    alias: string,
  ): Promise<ConnectionView> {
    const connection = await this.requireConnection(tenantId, connectionId);
    const normalized = sanitizeAlias(alias);
    const taken = (await this.deps.store.connections.listByTenant(tenantId))
      .filter((candidate) => candidate.id !== connectionId)
      .map((candidate) => candidate.alias);
    if (taken.includes(normalized)) {
      throw new GatewayError("CONFLICT", `The alias ${normalized} is already in use`);
    }
    const updated = await this.deps.store.connections.update(connection.id, {
      alias: normalized,
    });
    await this.syncCatalogue(updated).catch(() => undefined);
    return this.view(await this.reload(updated));
  }

  async setToolEnabled(
    tenantId: string,
    toolId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.deps.store.tools.setEnabled(tenantId, toolId, enabled);
  }

  async disconnect(tenantId: string, connectionId: string): Promise<void> {
    const connection = await this.requireConnection(tenantId, connectionId);
    await this.deps.tokenManager
      .revokeConnection({ tenantId, connectionId })
      .catch(() => undefined);
    await this.deps.sessions.releaseConnection(connectionId);
    await this.deps.store.tools.deleteByConnection(connectionId);
    await this.deps.store.resources.deleteByConnection(connectionId);
    await this.deps.store.prompts.deleteByConnection(connectionId);
    await this.deps.store.connections.delete(tenantId, connectionId);
    await this.deps.audit.record({
      tenantId,
      connectionId,
      operation: "connection.delete",
      resultStatus: "OK",
      detail: { alias: connection.alias },
    });
  }

  async listConnections(tenantId: string, userId: string): Promise<ConnectionView[]> {
    const connections = await this.deps.store.connections.listVisible(tenantId, userId);
    return Promise.all(connections.map((connection) => this.view(connection)));
  }

  async getConnection(tenantId: string, connectionId: string): Promise<ConnectionView> {
    return this.view(await this.requireConnection(tenantId, connectionId));
  }

  private async view(connection: UpstreamConnection): Promise<ConnectionView> {
    const server = await this.deps.store.mcpServers.get(
      connection.tenantId,
      connection.mcpServerId,
    );
    const tools = await this.deps.store.tools.listByConnection(connection.id);
    return {
      connectionId: connection.id,
      alias: connection.alias,
      status: connection.status,
      mcpUrl: server?.canonicalUrl ?? "",
      displayName: server?.displayName ?? connection.alias,
      serverName: server?.displayName ?? null,
      toolCount: tools.length,
      lastError: connection.lastErrorMessageRedacted,
    };
  }

  private async reload(connection: UpstreamConnection): Promise<UpstreamConnection> {
    return this.requireConnection(connection.tenantId, connection.id);
  }

  private async requireConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<UpstreamConnection> {
    const connection = await this.deps.store.connections.get(tenantId, connectionId);
    if (!connection) {
      this.deps.metrics.counter(Metric.TenantAccessDenied, { stage: "control_plane" });
      throw new GatewayError("NOT_FOUND", "Connection not found");
    }
    return connection;
  }

  private async requireServer(connection: UpstreamConnection): Promise<McpServerRecord> {
    const server = await this.deps.store.mcpServers.get(
      connection.tenantId,
      connection.mcpServerId,
    );
    if (!server) throw new GatewayError("NOT_FOUND", "MCP server record is missing");
    return server;
  }
}
