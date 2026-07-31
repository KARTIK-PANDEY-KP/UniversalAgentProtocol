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
} from "@uap/core";
import {
  InProcessLock,
  type DistributedLock,
  type LockContext,
  type LockOptions,
} from "@uap/security";

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
import type { SqlDriver } from "./driver.js";
import { SqliteDriver } from "./sqlite-driver.js";
import { Table } from "./table.js";
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
    private readonly db: SqlDriver,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async withLock<T>(
    key: string,
    fn: (context: LockContext) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const leaseMs = options.leaseMs ?? 30_000;
    const waitMs = options.waitMs ?? 15_000;
    // One deadline for both waits, so a caller asking to wait 15 seconds does
    // not wait 15 for the local queue and 15 more for the row.
    const deadline = this.now() + waitMs;

    return this.local.withLock(
      key,
      async (local) => {
        while (!(await this.tryAcquire(key, leaseMs))) {
          if (this.now() >= deadline) {
            throw new GatewayError("CONFLICT", `Timed out acquiring lock ${key}`, {
              retryable: true,
            });
          }
          await sleep(25 + Math.floor(Math.random() * 50));
        }

        const controller = new AbortController();
        const abortWithLocal = (): void => {
          controller.abort();
        };
        local.signal.addEventListener("abort", abortWithLocal, { once: true });

        // Extend the lease while the work runs. Without this a slow refresh
        // silently loses its lock to a replica that assumed it had died, and
        // two replicas rotate the same refresh token.
        const renewal = setInterval(
          () => {
            void this.renew(key, leaseMs).then(
              (held) => {
                if (!held) controller.abort();
              },
              () => controller.abort(),
            );
          },
          Math.max(1_000, Math.floor(leaseMs / 3)),
        );
        renewal.unref?.();

        try {
          return await fn({ signal: controller.signal });
        } finally {
          clearInterval(renewal);
          local.signal.removeEventListener("abort", abortWithLocal);
          await this.release(key);
        }
      },
      // The local lease covers the wait for the row as well as the work.
      { waitMs, leaseMs: waitMs + leaseMs },
    );
  }

  private async tryAcquire(key: string, leaseMs: number): Promise<boolean> {
    const now = this.now();
    const changed = await this.db.run(
      `INSERT INTO distributed_locks (key, owner, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE distributed_locks.expires_at <= ?`,
      [key, this.owner, now + leaseMs, now],
    );
    return changed > 0;
  }

  /** Returns false once the row is gone or another owner has taken it. */
  private async renew(key: string, leaseMs: number): Promise<boolean> {
    const changed = await this.db.run(
      `UPDATE distributed_locks SET expires_at = ? WHERE key = ? AND owner = ?`,
      [this.now() + leaseMs, key, this.owner],
    );
    return changed > 0;
  }

  private async release(key: string): Promise<void> {
    await this.db.run(`DELETE FROM distributed_locks WHERE key = ? AND owner = ?`, [
      key,
      this.owner,
    ]);
  }
}

export interface SqlStoreOptions {
  now?: () => number;
}

/**
 * The repositories, over whichever database the driver speaks to. There is no
 * SQLite variant and no Postgres variant because there is nothing left to
 * vary: the statements below are the intersection of the two dialects, and the
 * driver is the only thing that knows which one is answering.
 */
export class SqlGatewayStore implements GatewayStore {
  private readonly db: SqlDriver;

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

  constructor(driver: SqlDriver, options: SqlStoreOptions = {}) {
    this.db = driver;
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
      create: async (tenant) => await tenantTable.insert(tenant),
      get: async (id) => await tenantTable.findOne({ id }),
    };

    this.users = {
      create: async (user) => await userTable.insert(user),
      get: async (tenantId, id) => await userTable.findOne({ id, tenant_id: tenantId }),
    };

    this.memberships = {
      upsert: async (membership) =>
        await membershipTable.upsert(membership, ["tenant_id", "user_id"]),
      get: async (tenantId, userId) =>
        await membershipTable.findOne({ tenant_id: tenantId, user_id: userId }),
    };

    this.dpopKeys = {
      create: async (record) => await dpopKeyTable.insert(record),
      get: async (id) => await dpopKeyTable.findOne({ id }),
      delete: async (id) => {
        await dpopKeyTable.delete({ id });
      },
    };

    this.mcpServers = {
      create: async (record) => await serverTable.insert(record),
      get: async (tenantId, id) => await serverTable.findOne({ id, tenant_id: tenantId }),
      findByCanonicalUrl: async (tenantId, canonicalUrl) =>
        await serverTable.findOne({ tenant_id: tenantId, canonical_url: canonicalUrl }),
      update: async (tenantId, id, patch) => {
        await serverTable.update({ id, tenant_id: tenantId }, patch);
        return requireFound(
          await serverTable.findOne({ id, tenant_id: tenantId }),
          "MCP server",
        );
      },
    };

    this.issuers = {
      upsert: async (record) => await issuerTable.upsert(record, ["issuer"]),
      get: async (id) => await issuerTable.findOne({ id }),
      findByIssuer: async (issuer) => await issuerTable.findOne({ issuer }),
    };

    this.registrations = {
      create: async (record) => await registrationTable.insert(record),
      get: async (id) => await registrationTable.findOne({ id }),
      findActive: async (tenantId, issuerId) =>
        await registrationTable.findOne({
          tenant_id: tenantId,
          issuer_id: issuerId,
          status: "ACTIVE",
        }),
      list: async (tenantId, issuerId) =>
        await registrationTable.findMany(
          { tenant_id: tenantId, issuer_id: issuerId },
          "issued_at",
        ),
      update: async (id, patch) => {
        await registrationTable.update({ id }, patch);
        return requireFound(await registrationTable.findOne({ id }), "Client registration");
      },
    };

    this.connections = {
      create: async (record) => await connectionTable.insert(record),
      get: async (tenantId, id) => await connectionTable.findOne({ id, tenant_id: tenantId }),
      getUnscoped: async (id) => await connectionTable.findOne({ id }),
      listByTenant: async (tenantId) =>
        await connectionTable.findMany({ tenant_id: tenantId }, "created_at"),
      listVisible: async (tenantId, userId) => {
        const connections = await connectionTable.findMany(
          { tenant_id: tenantId },
          "created_at",
        );
        return connections.filter((connection) => isVisibleTo(connection, userId));
      },
      findVisible: async (tenantId, userId, id) => {
        const connection = await connectionTable.findOne({ id, tenant_id: tenantId });
        if (!connection || !isVisibleTo(connection, userId)) return null;
        return connection;
      },
      listAll: async () => await connectionTable.findMany({}, "created_at"),
      findByAlias: async (tenantId, alias) =>
        await connectionTable.findOne({ tenant_id: tenantId, alias }),
      update: async (id, patch) => {
        await connectionTable.update({ id }, { ...patch, updatedAt: now() });
        return requireFound(await connectionTable.findOne({ id }), "Connection");
      },
      updateTokens: async (update: TokenUpdate) => {
        const changed = await connectionTable.updateRaw(
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
        await connectionTable.delete({ id, tenant_id: tenantId }) > 0,
    };

    this.transactions = {
      create: async (record) => await transactionTable.insert(record),
      findByStateHash: async (stateHash) =>
        await transactionTable.findOne({ state_hash: stateHash }),
      consume: async (id, at) => {
        const changed = await transactionTable.updateRaw(
          { id, consumed_at: null, status: "PENDING" },
          { consumed_at: at, status: "CONSUMED" },
        );
        return changed === 1;
      },
      fail: async (id) => {
        await transactionTable.update({ id }, { status: "FAILED" });
      },
      purgeExpired: async (nowMs) => {
        const rows = await transactionTable.findMany({}, undefined);
        let removed = 0;
        for (const row of rows) {
          if (row.expiresAt < nowMs) removed += await transactionTable.delete({ id: row.id });
        }
        return removed;
      },
    };

    this.tools = {
      sync: async (connectionId, tools, seenAt) =>
        syncTools(toolTable, connectionId, tools, seenAt),
      listByTenant: async (tenantId) =>
        await toolTable.findMany({ tenant_id: tenantId }, "gateway_name"),
      listByConnection: async (connectionId) =>
        await toolTable.findMany({ connection_id: connectionId }, "gateway_name"),
      findByGatewayName: async (tenantId, gatewayName) =>
        await toolTable.findOne({ tenant_id: tenantId, gateway_name: gatewayName }),
      setEnabled: async (tenantId, id, enabled) => {
        await toolTable.update({ id, tenant_id: tenantId }, { enabled });
      },
      deleteByConnection: async (connectionId) => {
        await toolTable.delete({ connection_id: connectionId });
      },
    };

    this.resources = {
      sync: async (connectionId, resources) => {
        const before = await resourceTable.findMany({ connection_id: connectionId }, "gateway_uri");
        await resourceTable.delete({ connection_id: connectionId });
        for (const resource of resources) await resourceTable.insert(resource);
        return differs(
          before.map(resourceIdentity),
          resources.map(resourceIdentity),
        );
      },
      listByTenant: async (tenantId) =>
        await resourceTable.findMany({ tenant_id: tenantId }, "gateway_uri"),
      findByGatewayUri: async (tenantId, gatewayUri) =>
        await resourceTable.findOne({ tenant_id: tenantId, gateway_uri: gatewayUri }),
      deleteByConnection: async (connectionId) => {
        await resourceTable.delete({ connection_id: connectionId });
      },
    };

    this.prompts = {
      sync: async (connectionId, prompts) => {
        const before = await promptTable.findMany({ connection_id: connectionId }, "gateway_name");
        await promptTable.delete({ connection_id: connectionId });
        for (const prompt of prompts) await promptTable.insert(prompt);
        return differs(before.map(promptIdentity), prompts.map(promptIdentity));
      },
      listByTenant: async (tenantId) =>
        await promptTable.findMany({ tenant_id: tenantId }, "gateway_name"),
      findByGatewayName: async (tenantId, gatewayName) =>
        await promptTable.findOne({ tenant_id: tenantId, gateway_name: gatewayName }),
      deleteByConnection: async (connectionId) => {
        await promptTable.delete({ connection_id: connectionId });
      },
    };

    this.downstreamSessions = {
      create: async (record) => await downstreamTable.insert(record),
      get: async (id) => await downstreamTable.findOne({ id }),
      close: async (id) => {
        await downstreamTable.update({ id }, { status: "CLOSED" });
      },
    };

    this.upstreamSessions = {
      upsert: async (record) =>
        await upstreamTable.upsert(record, ["connection_id", "downstream_session_id"]),
      find: async (connectionId, downstreamSessionId) =>
        await upstreamTable.findOne({
          connection_id: connectionId,
          downstream_session_id: downstreamSessionId,
          status: "ACTIVE",
        }),
      closeByDownstream: async (downstreamSessionId) => {
        await upstreamTable.delete({ downstream_session_id: downstreamSessionId });
      },
      closeByConnection: async (connectionId) => {
        await upstreamTable.delete({ connection_id: connectionId });
      },
    };

    this.audit = {
      append: async (event) => {
        await auditTable.insert(event);
      },
      list: async (tenantId, limit) =>
        await auditTable.findMany({ tenant_id: tenantId }, "created_at DESC", limit),
    };

    this.preconfiguredClients = {
      upsert: async (record) =>
        await preconfiguredTable.upsert(record, ["tenant_id", "issuer"]),
      findByIssuer: async (tenantId, issuer) =>
        await preconfiguredTable.findOne({ tenant_id: tenantId, issuer }),
      list: async (tenantId) =>
        await preconfiguredTable.findMany({ tenant_id: tenantId }, "created_at"),
      delete: async (tenantId, id) =>
        await preconfiguredTable.delete({ id, tenant_id: tenantId }) > 0,
    };
  }

  /** Creates the schema. Separate from the constructor because it is I/O. */
  async init(): Promise<void> {
    await this.db.init(DDL);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function isVisibleTo(connection: UpstreamConnection, userId: string): boolean {
  return connection.ownerType === "WORKSPACE" || connection.ownerId === userId;
}

async function syncTools(
  table: Table<DiscoveredTool>,
  connectionId: string,
  tools: DiscoveredTool[],
  seenAt: number,
): Promise<ToolSyncResult> {
  const existing = await table.findMany({ connection_id: connectionId });
  const byUpstreamName = new Map(existing.map((tool) => [tool.upstreamName, tool]));
  const result: ToolSyncResult = { added: [], removed: [], changed: [], unchanged: [] };

  for (const tool of tools) {
    const previous = byUpstreamName.get(tool.upstreamName);
    if (!previous) {
      await table.insert({ ...tool, discoveredAt: seenAt, lastSeenAt: seenAt });
      result.added.push(tool.gatewayName);
      continue;
    }
    byUpstreamName.delete(tool.upstreamName);
    if (previous.schemaHash !== tool.schemaHash || previous.gatewayName !== tool.gatewayName) {
      await table.update(
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
    await table.update({ id: previous.id }, { lastSeenAt: seenAt });
    result.unchanged.push(tool.gatewayName);
  }

  for (const stale of byUpstreamName.values()) {
    await table.delete({ id: stale.id });
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

/** A private SQLite database that lasts as long as the object does. */
export async function createInMemoryStore(now?: () => number): Promise<SqlGatewayStore> {
  const options: SqlStoreOptions = {};
  if (now) options.now = now;
  const store = new SqlGatewayStore(new SqliteDriver({ filename: ":memory:" }), options);
  await store.init();
  return store;
}
