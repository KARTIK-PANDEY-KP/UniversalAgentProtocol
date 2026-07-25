import type {
  AuditEvent,
  ConnectionStatus,
  DiscoveredPrompt,
  DiscoveredResource,
  DiscoveredTool,
  DownstreamSession,
  DpopKeyRecord,
  McpServerRecord,
  OAuthClientRegistrationRecord,
  OAuthIssuerRecord,
  OAuthTransaction,
  PreconfiguredOAuthClient,
  Tenant,
  TenantMembership,
  UpstreamConnection,
  UpstreamSessionRecord,
  User,
} from "@uap/core";
import type { DistributedLock } from "@uap/security";

export interface TokenUpdate {
  connectionId: string;
  expectedTokenVersion: number;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenType: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  grantedScopes: string[];
  status: ConnectionStatus;
  lastRefreshAt: number;
}

export interface ToolSyncResult {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export interface TenantRepository {
  create(tenant: Tenant): Promise<Tenant>;
  get(id: string): Promise<Tenant | null>;
}

export interface UserRepository {
  create(user: User): Promise<User>;
  get(tenantId: string, id: string): Promise<User | null>;
}

export interface MembershipRepository {
  upsert(membership: TenantMembership): Promise<TenantMembership>;
  get(tenantId: string, userId: string): Promise<TenantMembership | null>;
}

export interface DpopKeyRepository {
  create(record: DpopKeyRecord): Promise<DpopKeyRecord>;
  get(id: string): Promise<DpopKeyRecord | null>;
  delete(id: string): Promise<void>;
}

export interface McpServerRepository {
  create(record: McpServerRecord): Promise<McpServerRecord>;
  get(tenantId: string, id: string): Promise<McpServerRecord | null>;
  findByCanonicalUrl(
    tenantId: string,
    canonicalUrl: string,
  ): Promise<McpServerRecord | null>;
  update(
    tenantId: string,
    id: string,
    patch: Partial<McpServerRecord>,
  ): Promise<McpServerRecord>;
}

export interface OAuthIssuerRepository {
  upsert(record: OAuthIssuerRecord): Promise<OAuthIssuerRecord>;
  get(id: string): Promise<OAuthIssuerRecord | null>;
  findByIssuer(issuer: string): Promise<OAuthIssuerRecord | null>;
}

export interface ClientRegistrationRepository {
  create(
    record: OAuthClientRegistrationRecord,
  ): Promise<OAuthClientRegistrationRecord>;
  get(id: string): Promise<OAuthClientRegistrationRecord | null>;
  /** Registrations are keyed by tenant and authorization server issuer. */
  findActive(
    tenantId: string,
    issuerId: string,
  ): Promise<OAuthClientRegistrationRecord | null>;
  update(
    id: string,
    patch: Partial<OAuthClientRegistrationRecord>,
  ): Promise<OAuthClientRegistrationRecord>;
}

export interface ConnectionRepository {
  create(record: UpstreamConnection): Promise<UpstreamConnection>;
  get(tenantId: string, id: string): Promise<UpstreamConnection | null>;
  /** Only for background jobs that legitimately span tenants. */
  getUnscoped(id: string): Promise<UpstreamConnection | null>;
  listByTenant(tenantId: string): Promise<UpstreamConnection[]>;
  /**
   * Workspace connections belong to every member; a personal connection is
   * only the owner's. Sharing a tenant must not hand one member another
   * member's credentials.
   */
  listVisible(
    tenantId: string,
    userId: string,
  ): Promise<UpstreamConnection[]>;
  /** The same visibility rule, for a single connection. */
  findVisible(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<UpstreamConnection | null>;
  listAll(): Promise<UpstreamConnection[]>;
  findByAlias(tenantId: string, alias: string): Promise<UpstreamConnection | null>;
  update(
    id: string,
    patch: Partial<UpstreamConnection>,
  ): Promise<UpstreamConnection>;
  /**
   * Compare-and-swap on `tokenVersion`. Returns false when another worker
   * already rotated the credentials, which is how refresh races are resolved
   * without ever leaving two refresh tokens live.
   */
  updateTokens(update: TokenUpdate): Promise<boolean>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export interface TransactionRepository {
  create(record: OAuthTransaction): Promise<OAuthTransaction>;
  findByStateHash(stateHash: string): Promise<OAuthTransaction | null>;
  /** Atomically marks a transaction used; false when already consumed. */
  consume(id: string, at: number): Promise<boolean>;
  fail(id: string): Promise<void>;
  purgeExpired(now: number): Promise<number>;
}

export interface ToolRepository {
  sync(
    connectionId: string,
    tools: DiscoveredTool[],
    seenAt: number,
  ): Promise<ToolSyncResult>;
  listByTenant(tenantId: string): Promise<DiscoveredTool[]>;
  listByConnection(connectionId: string): Promise<DiscoveredTool[]>;
  findByGatewayName(
    tenantId: string,
    gatewayName: string,
  ): Promise<DiscoveredTool | null>;
  setEnabled(tenantId: string, id: string, enabled: boolean): Promise<void>;
  deleteByConnection(connectionId: string): Promise<void>;
}

export interface ResourceRepository {
  /** Replaces the connection's resources; true when the catalogue changed. */
  sync(connectionId: string, resources: DiscoveredResource[]): Promise<boolean>;
  listByTenant(tenantId: string): Promise<DiscoveredResource[]>;
  findByGatewayUri(
    tenantId: string,
    gatewayUri: string,
  ): Promise<DiscoveredResource | null>;
  deleteByConnection(connectionId: string): Promise<void>;
}

export interface PromptRepository {
  /** Replaces the connection's prompts; true when the catalogue changed. */
  sync(connectionId: string, prompts: DiscoveredPrompt[]): Promise<boolean>;
  listByTenant(tenantId: string): Promise<DiscoveredPrompt[]>;
  findByGatewayName(
    tenantId: string,
    gatewayName: string,
  ): Promise<DiscoveredPrompt | null>;
  deleteByConnection(connectionId: string): Promise<void>;
}

export interface DownstreamSessionRepository {
  create(record: DownstreamSession): Promise<DownstreamSession>;
  get(id: string): Promise<DownstreamSession | null>;
  close(id: string): Promise<void>;
}

export interface UpstreamSessionRepository {
  upsert(record: UpstreamSessionRecord): Promise<UpstreamSessionRecord>;
  find(
    connectionId: string,
    downstreamSessionId: string,
  ): Promise<UpstreamSessionRecord | null>;
  closeByDownstream(downstreamSessionId: string): Promise<void>;
  closeByConnection(connectionId: string): Promise<void>;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(tenantId: string, limit: number): Promise<AuditEvent[]>;
}

export interface PreconfiguredClientRepository {
  upsert(record: PreconfiguredOAuthClient): Promise<PreconfiguredOAuthClient>;
  findByIssuer(
    tenantId: string,
    issuer: string,
  ): Promise<PreconfiguredOAuthClient | null>;
  list(tenantId: string): Promise<PreconfiguredOAuthClient[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export interface GatewayStore {
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
  /** Creates the schema if it is not there. Safe to call on every boot. */
  init(): Promise<void>;
  close(): Promise<void>;
}
