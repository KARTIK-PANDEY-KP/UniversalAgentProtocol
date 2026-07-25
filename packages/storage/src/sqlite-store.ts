import { DatabaseSync } from "node:sqlite";

import {
  GatewayError,
  randomToken,
  sleep,
  type AuditEvent,
  type DiscoveredPrompt,
  type DiscoveredResource,
  type DiscoveredTool,
  type DownstreamSession,
  type DpopKeyRecord,
  type McpServerRecord,
  type OAuthClientRegistrationRecord,
  type OAuthIssuerRecord,
  type OAuthTransaction,
  type PreconfiguredOAuthClient,
  type Tenant,
  type TenantMembership,
  type UpstreamConnection,
  type UpstreamSessionRecord,
  type User,
} from "@umg/core";
import { InProcessLock, type DistributedLock, type LockOptions } from "@umg/security";

import {
  DDL,
  auditMapper,
  connectionMapper,
  downstreamSessionMapper,
  dpopKeyMapper,
  issuerMapper,
  mcpServerMapper,
  membershipMapper,
  preconfiguredClientMapper,
  promptMapper,
  registrationMapper,
  resourceMapper,
  tenantMapper,
  toolMapper,
  transactionMapper,
  upstreamSessionMapper,
  userMapper,
} from "./schema.js";
import { Table } from "./sqlite-table.js";
import type {
  AuditRepository,
  ClientRegistrationRepository,
  ConnectionRepository,
  DownstreamSessionRepository,
  GatewayStore,
  McpServerRepository,
  MembershipRepository,
  DpopKeyRepository,
  OAuthIssuerRepository,
  PreconfiguredClientRepository,
  PromptRepository,
  ResourceRepository,
  TenantRepository,
  ToolRepository,
  ToolSyncResult,
  TokenUpdate,
  TransactionRepository,
  UpstreamSessionRepository,
  UserRepository,
} from "./store.js";

function requireFound<T>(value: T | null, what: string): T {
  if (value === null) throw new GatewayError("NOT_FOUND", `${what} not found`);
  return value;
}

/**
 * Lease based lock stored in the database, layered on an in-process mutex.
 * The in-process part removes contention inside one replica; the lease row
 * keeps two replicas from refreshing the same connection at the same time.
 */
class SqlLeaseLock implements DistributedLock {
  private readonly local = new InProcessLock();
  private readonly owner = randomToken(8);

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const leaseMs = options.leaseMs ?? 30_000;
    const waitMs = options.waitMs ?? 15_000;
    return this.local.withLock(key, async () => {
      const deadline = this.now() + waitMs;
      while (!this.tryAcquire(key, leaseMs)) {
        if (this.now() >= deadline) {
          throw new GatewayError("CONFLICT", `Timed out acquiring lock ${key}`, {
            retryable: true,
          });
        }
        await sleep(25 + Math.floor(Math.random() * 50));
      }
      try {
        return await fn();
      } finally {
        this.release(key);
      }
    });
  }

  private tryAcquire(key: string, leaseMs: number): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO distributed_locks (key, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE distributed_locks.expires_at <= ?`,
      )
      .run(key, this.owner, now + leaseMs, now);
    return Number(result.changes) > 0;
  }

  private release(key: string): void {
    this.db
      .prepare(`DELETE FROM distributed_locks WHERE key = ? AND owner = ?`)
      .run(key, this.owner);
  }
}

export interface SqliteStoreOptions {
  filename?: string;
  now?: () => number;
}

export class SqliteGatewayStore implements GatewayStore {
  private readonly db: DatabaseSync;

  readonly tenants: TenantRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
  readonly dpopKeys: DpopKeyRepository;
  readonly mcpServers: McpServerRepository;
  readonly issuers: OAuthIssuerRepository;
  readonly registrations: ClientRegistrationRepository;
  readonly connections: ConnectionRepository;
  readonly transactions: TransactionRepository;
  readonly tools: ToolRepository;
  readonly resources: ResourceRepository;
  readonly prompts: PromptRepository;
  readonly downstreamSessions: DownstreamSessionRepository;
  readonly upstreamSessions: UpstreamSessionRepository;
  readonly audit: AuditRepository;
  readonly preconfiguredClients: PreconfiguredClientRepository;
  readonly locks: DistributedLock;

  constructor(options: SqliteStoreOptions = {}) {
    this.db = new DatabaseSync(options.filename ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(DDL);
    const now = options.now ?? (() => Date.now());

    const tenantTable = new Table<Tenant>(this.db, "tenants", tenantMapper);
    const userTable = new Table<User>(this.db, "users", userMapper);
    const membershipTable = new Table<TenantMembership>(
      this.db,
      "tenant_memberships",
      membershipMapper,
    );
    const dpopKeyTable = new Table<DpopKeyRecord>(this.db, "dpop_keys", dpopKeyMapper);
    const serverTable = new Table<McpServerRecord>(this.db, "mcp_servers", mcpServerMapper);
    const issuerTable = new Table<OAuthIssuerRecord>(this.db, "oauth_issuers", issuerMapper);
    const registrationTable = new Table<OAuthClientRegistrationRecord>(
      this.db,
      "oauth_client_registrations",
      registrationMapper,
    );
    const connectionTable = new Table<UpstreamConnection>(
      this.db,
      "upstream_connections",
      connectionMapper,
    );
    const transactionTable = new Table<OAuthTransaction>(
      this.db,
      "oauth_transactions",
      transactionMapper,
    );
    const toolTable = new Table<DiscoveredTool>(this.db, "discovered_tools", toolMapper);
    const resourceTable = new Table<DiscoveredResource>(
      this.db,
      "discovered_resources",
      resourceMapper,
    );
    const promptTable = new Table<DiscoveredPrompt>(
      this.db,
      "discovered_prompts",
      promptMapper,
    );
    const downstreamTable = new Table<DownstreamSession>(
      this.db,
      "downstream_mcp_sessions",
      downstreamSessionMapper,
    );
    const upstreamTable = new Table<UpstreamSessionRecord>(
      this.db,
      "upstream_mcp_sessions",
      upstreamSessionMapper,
    );
    const auditTable = new Table<AuditEvent>(this.db, "audit_events", auditMapper);
    const preconfiguredTable = new Table<PreconfiguredOAuthClient>(
      this.db,
      "preconfigured_oauth_clients",
      preconfiguredClientMapper,
    );

    this.locks = new SqlLeaseLock(this.db, now);

    this.tenants = {
      create: async (tenant) => tenantTable.insert(tenant),
      get: async (id) => tenantTable.findOne({ id }),
    };

    this.users = {
      create: async (user) => userTable.insert(user),
      get: async (tenantId, id) => userTable.findOne({ id, tenant_id: tenantId }),
    };

    this.memberships = {
      upsert: async (membership) => {
        const existing = membershipTable.findOne({
          tenant_id: membership.tenantId,
          user_id: membership.userId,
        });
        if (!existing) return membershipTable.insert(membership);
        membershipTable.update(
          { tenant_id: membership.tenantId, user_id: membership.userId },
          { role: membership.role },
        );
        return { ...existing, role: membership.role };
      },
      get: async (tenantId, userId) =>
        membershipTable.findOne({ tenant_id: tenantId, user_id: userId }),
    };

    this.dpopKeys = {
      create: async (record) => dpopKeyTable.insert(record),
      get: async (id) => dpopKeyTable.findOne({ id }),
      delete: async (id) => {
        dpopKeyTable.delete({ id });
      },
    };

    this.mcpServers = {
      create: async (record) => serverTable.insert(record),
      get: async (tenantId, id) => serverTable.findOne({ id, tenant_id: tenantId }),
      findByCanonicalUrl: async (tenantId, canonicalUrl) =>
        serverTable.findOne({ tenant_id: tenantId, canonical_url: canonicalUrl }),
      update: async (tenantId, id, patch) => {
        serverTable.update({ id, tenant_id: tenantId }, patch);
        return requireFound(
          serverTable.findOne({ id, tenant_id: tenantId }),
          "MCP server",
        );
      },
    };

    this.issuers = {
      upsert: async (record) => issuerTable.upsert(record, ["issuer"]),
      get: async (id) => issuerTable.findOne({ id }),
      findByIssuer: async (issuer) => issuerTable.findOne({ issuer }),
    };

    this.registrations = {
      create: async (record) => registrationTable.insert(record),
      get: async (id) => registrationTable.findOne({ id }),
      findActive: async (tenantId, issuerId) =>
        registrationTable.findOne({
          tenant_id: tenantId,
          issuer_id: issuerId,
          status: "ACTIVE",
        }),
      update: async (id, patch) => {
        registrationTable.update({ id }, patch);
        return requireFound(registrationTable.findOne({ id }), "Client registration");
      },
    };

    this.connections = {
      create: async (record) => connectionTable.insert(record),
      get: async (tenantId, id) => connectionTable.findOne({ id, tenant_id: tenantId }),
      getUnscoped: async (id) => connectionTable.findOne({ id }),
      listByTenant: async (tenantId) =>
        connectionTable.findMany({ tenant_id: tenantId }, "created_at"),
      listVisible: async (tenantId, userId) =>
        connectionTable
          .findMany({ tenant_id: tenantId }, "created_at")
          .filter((connection) => isVisibleTo(connection, userId)),
      findVisible: async (tenantId, userId, id) => {
        const connection = connectionTable.findOne({ id, tenant_id: tenantId });
        if (!connection || !isVisibleTo(connection, userId)) return null;
        return connection;
      },
      listAll: async () => connectionTable.findMany({}, "created_at"),
      findByAlias: async (tenantId, alias) =>
        connectionTable.findOne({ tenant_id: tenantId, alias }),
      update: async (id, patch) => {
        connectionTable.update({ id }, { ...patch, updatedAt: now() });
        return requireFound(connectionTable.findOne({ id }), "Connection");
      },
      updateTokens: async (update: TokenUpdate) => {
        const changed = connectionTable.updateRaw(
          {
            id: update.connectionId,
            token_version: update.expectedTokenVersion,
          },
          {
            access_token_encrypted: update.accessTokenEncrypted,
            refresh_token_encrypted: update.refreshTokenEncrypted,
            token_type: update.tokenType,
            access_token_expires_at: update.accessTokenExpiresAt,
            refresh_token_expires_at: update.refreshTokenExpiresAt,
            granted_scopes: JSON.stringify(update.grantedScopes),
            status: update.status,
            token_version: update.expectedTokenVersion + 1,
            last_refresh_at: update.lastRefreshAt,
            last_error_code: null,
            last_error_message_redacted: null,
            updated_at: now(),
          },
        );
        return changed === 1;
      },
      delete: async (tenantId, id) =>
        connectionTable.delete({ id, tenant_id: tenantId }) > 0,
    };

    this.transactions = {
      create: async (record) => transactionTable.insert(record),
      findByStateHash: async (stateHash) =>
        transactionTable.findOne({ state_hash: stateHash }),
      consume: async (id, at) => {
        const changed = transactionTable.updateRaw(
          { id, consumed_at: null, status: "PENDING" },
          { consumed_at: at, status: "CONSUMED" },
        );
        return changed === 1;
      },
      fail: async (id) => {
        transactionTable.update({ id }, { status: "FAILED" });
      },
      purgeExpired: async (nowMs) => {
        const rows = transactionTable.findMany({}, undefined);
        let removed = 0;
        for (const row of rows) {
          if (row.expiresAt < nowMs) removed += transactionTable.delete({ id: row.id });
        }
        return removed;
      },
    };

    this.tools = {
      sync: async (connectionId, tools, seenAt) =>
        syncTools(toolTable, connectionId, tools, seenAt),
      listByTenant: async (tenantId) =>
        toolTable.findMany({ tenant_id: tenantId }, "gateway_name"),
      listByConnection: async (connectionId) =>
        toolTable.findMany({ connection_id: connectionId }, "gateway_name"),
      findByGatewayName: async (tenantId, gatewayName) =>
        toolTable.findOne({ tenant_id: tenantId, gateway_name: gatewayName }),
      setEnabled: async (tenantId, id, enabled) => {
        toolTable.update({ id, tenant_id: tenantId }, { enabled });
      },
      deleteByConnection: async (connectionId) => {
        toolTable.delete({ connection_id: connectionId });
      },
    };

    this.resources = {
      sync: async (connectionId, resources) => {
        const before = resourceTable.findMany({ connection_id: connectionId }, "gateway_uri");
        resourceTable.delete({ connection_id: connectionId });
        for (const resource of resources) resourceTable.insert(resource);
        return differs(
          before.map(resourceIdentity),
          resources.map(resourceIdentity),
        );
      },
      listByTenant: async (tenantId) =>
        resourceTable.findMany({ tenant_id: tenantId }, "gateway_uri"),
      findByGatewayUri: async (tenantId, gatewayUri) =>
        resourceTable.findOne({ tenant_id: tenantId, gateway_uri: gatewayUri }),
      deleteByConnection: async (connectionId) => {
        resourceTable.delete({ connection_id: connectionId });
      },
    };

    this.prompts = {
      sync: async (connectionId, prompts) => {
        const before = promptTable.findMany({ connection_id: connectionId }, "gateway_name");
        promptTable.delete({ connection_id: connectionId });
        for (const prompt of prompts) promptTable.insert(prompt);
        return differs(before.map(promptIdentity), prompts.map(promptIdentity));
      },
      listByTenant: async (tenantId) =>
        promptTable.findMany({ tenant_id: tenantId }, "gateway_name"),
      findByGatewayName: async (tenantId, gatewayName) =>
        promptTable.findOne({ tenant_id: tenantId, gateway_name: gatewayName }),
      deleteByConnection: async (connectionId) => {
        promptTable.delete({ connection_id: connectionId });
      },
    };

    this.downstreamSessions = {
      create: async (record) => downstreamTable.insert(record),
      get: async (id) => downstreamTable.findOne({ id }),
      close: async (id) => {
        downstreamTable.update({ id }, { status: "CLOSED" });
      },
    };

    this.upstreamSessions = {
      upsert: async (record) =>
        upstreamTable.upsert(record, ["connection_id", "downstream_session_id"]),
      find: async (connectionId, downstreamSessionId) =>
        upstreamTable.findOne({
          connection_id: connectionId,
          downstream_session_id: downstreamSessionId,
          status: "ACTIVE",
        }),
      closeByDownstream: async (downstreamSessionId) => {
        upstreamTable.delete({ downstream_session_id: downstreamSessionId });
      },
      closeByConnection: async (connectionId) => {
        upstreamTable.delete({ connection_id: connectionId });
      },
    };

    this.audit = {
      append: async (event) => {
        auditTable.insert(event);
      },
      list: async (tenantId, limit) =>
        auditTable.findMany({ tenant_id: tenantId }, "created_at DESC", limit),
    };

    this.preconfiguredClients = {
      upsert: async (record) =>
        preconfiguredTable.upsert(record, ["tenant_id", "issuer"]),
      findByIssuer: async (tenantId, issuer) =>
        preconfiguredTable.findOne({ tenant_id: tenantId, issuer }),
      list: async (tenantId) =>
        preconfiguredTable.findMany({ tenant_id: tenantId }, "created_at"),
      delete: async (tenantId, id) =>
        preconfiguredTable.delete({ id, tenant_id: tenantId }) > 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

function isVisibleTo(connection: UpstreamConnection, userId: string): boolean {
  return connection.ownerType === "WORKSPACE" || connection.ownerId === userId;
}

function syncTools(
  table: Table<DiscoveredTool>,
  connectionId: string,
  tools: DiscoveredTool[],
  seenAt: number,
): ToolSyncResult {
  const existing = table.findMany({ connection_id: connectionId });
  const byUpstreamName = new Map(existing.map((tool) => [tool.upstreamName, tool]));
  const result: ToolSyncResult = { added: [], removed: [], changed: [], unchanged: [] };

  for (const tool of tools) {
    const previous = byUpstreamName.get(tool.upstreamName);
    if (!previous) {
      table.insert({ ...tool, discoveredAt: seenAt, lastSeenAt: seenAt });
      result.added.push(tool.gatewayName);
      continue;
    }
    byUpstreamName.delete(tool.upstreamName);
    if (previous.schemaHash !== tool.schemaHash || previous.gatewayName !== tool.gatewayName) {
      table.update(
        { id: previous.id },
        {
          gatewayName: tool.gatewayName,
          description: tool.description,
          inputSchemaJson: tool.inputSchemaJson,
          outputSchemaJson: tool.outputSchemaJson,
          annotationsJson: tool.annotationsJson,
          schemaHash: tool.schemaHash,
          riskLevel: tool.riskLevel,
          lastSeenAt: seenAt,
        },
      );
      result.changed.push(tool.gatewayName);
      continue;
    }
    table.update({ id: previous.id }, { lastSeenAt: seenAt });
    result.unchanged.push(tool.gatewayName);
  }

  for (const stale of byUpstreamName.values()) {
    table.delete({ id: stale.id });
    result.removed.push(stale.gatewayName);
  }
  return result;
}

/** Identity of a resource for change detection: what a client would notice. */
function resourceIdentity(resource: DiscoveredResource): string {
  return [
    resource.gatewayUri,
    resource.name,
    resource.description ?? "",
    resource.mimeType ?? "",
  ].join("\u0000");
}

function promptIdentity(prompt: DiscoveredPrompt): string {
  return [
    prompt.gatewayName,
    prompt.description ?? "",
    JSON.stringify(prompt.argumentsJson ?? null),
  ].join("\u0000");
}

function differs(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return true;
  const sortedBefore = [...before].sort();
  const sortedAfter = [...after].sort();
  return sortedBefore.some((entry, index) => entry !== sortedAfter[index]);
}

export function createInMemoryStore(now?: () => number): SqliteGatewayStore {
  const options: SqliteStoreOptions = { filename: ":memory:" };
  if (now) options.now = now;
  return new SqliteGatewayStore(options);
}
