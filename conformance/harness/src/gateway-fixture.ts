import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import { Gateway, type GatewayConfig } from "@uap/gateway";
import { silentSink, type LogSink } from "@uap/observability";
import { PostgresDriver } from "@uap/storage";

/**
 * The suite runs against SQLite by default and against Postgres when one is
 * offered, which is the only way to find out whether the conformance the
 * gateway demonstrates depends on the database underneath it.
 *
 * Each gateway gets a schema of its own, because these tests share tenant and
 * connection ids and a shared schema would have them reading each other's rows.
 */
/**
 * Takes the schema away again when the gateway stops.
 *
 * A suite run stands up something over a hundred gateways, and a schema holds
 * seventeen tables, so leaving them behind is tens of thousands of relations
 * per run against one database. That is not untidiness: the catalogue grows
 * until the server itself gives out, which it does in the middle of some
 * unrelated test, looking like a bug in whatever happened to be running.
 */
async function dropSchema(connectionString: string, schema: string): Promise<void> {
  const driver = new PostgresDriver({ connectionString });
  try {
    await driver.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
  } finally {
    await driver.close();
  }
}

function databaseConfig(): Partial<GatewayConfig> {
  const url = process.env["TEST_POSTGRES_URL"];
  if (!url) return { databaseFile: ":memory:" };
  return {
    databaseUrl: url,
    databaseSchema: `t_${randomBytes(8).toString("hex")}`,
  };
}

export interface GatewayFixtureOptions {
  apiKey?: string;
  tenantId?: string;
  userId?: string;
  /** Workspace role of the default principal. */
  role?: string;
  config?: Partial<GatewayConfig>;
  /** Collects log records so a test can assert nothing sensitive was written. */
  captureLogs?: boolean;
}

export interface ConnectionSummary {
  connection_id: string;
  alias: string;
  status: string;
  mcp_url: string;
  display_name: string;
  tool_count: number;
  last_error: string | null;
  authorization_url?: string;
  connect_url?: string;
}

/**
 * Boots a real gateway on an ephemeral loopback port and exposes typed helpers
 * for its control plane. Nothing is stubbed: the gateway runs its own HTTP
 * server, SQLite store, OAuth engine and MCP transports.
 */
export class GatewayFixture {
  private gateway: Gateway | null = null;
  private origin = "";

  readonly apiKey: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly logs: Record<string, unknown>[] = [];

  constructor(private readonly options: GatewayFixtureOptions = {}) {
    this.apiKey = options.apiKey ?? "test-gateway-key";
    this.tenantId = options.tenantId ?? "tenant_test";
    this.userId = options.userId ?? "user_test";
  }

  get baseUrl(): string {
    if (!this.origin) throw new Error("The gateway fixture has not been started");
    return this.origin;
  }

  get services(): Gateway["services"] {
    if (!this.gateway) throw new Error("The gateway fixture has not been started");
    return this.gateway.services;
  }

  async start(): Promise<string> {
    const port = await reservePort();
    this.origin = `http://127.0.0.1:${port}`;
    const sink: LogSink = this.options.captureLogs
      ? (record) => {
          this.logs.push(record);
        }
      : silentSink;

    this.gateway = new Gateway({
      logSink: sink,
      config: {
        baseUrl: this.origin,
        host: "127.0.0.1",
        port,
        ...databaseConfig(),
        logLevel: this.options.captureLogs ? "debug" : "info",
        allowHttp: true,
        allowLoopback: true,
        allowPrivateNetworks: false,
        allowedOrigins: [],
        apiKeys: [
          {
            key: this.apiKey,
            tenantId: this.tenantId,
            userId: this.userId,
            label: "conformance",
            role: this.options.role ?? "member",
          },
        ],
        gatewayAuthorizationServers: [],
        requestTimeoutMs: 15_000,
        ...(this.options.config ?? {}),
      },
    });
    await this.gateway.listen(port);
    return this.origin;
  }

  async stop(): Promise<void> {
    const schema = this.gateway?.services.config.databaseSchema ?? null;
    const url = this.gateway?.services.config.databaseUrl ?? null;
    await this.gateway?.close();
    this.gateway = null;
    if (schema && url) await dropSchema(url, schema);
  }

  /** Adds a second principal so cross-tenant isolation can be exercised. */
  async addPrincipal(principal: {
    key: string;
    tenantId: string;
    userId: string;
    label?: string;
    role?: string;
  }): Promise<void> {
    const { store, clock, config } = this.services;
    const role = principal.role ?? "member";
    config.apiKeys.push({
      key: principal.key,
      tenantId: principal.tenantId,
      userId: principal.userId,
      label: principal.label ?? "conformance",
      role,
    });
    await store.tenants
      .create({
        id: principal.tenantId,
        name: principal.tenantId,
        status: "ACTIVE",
        createdAt: clock.now(),
      })
      .catch(() => undefined);
    await store.users
      .create({
        id: principal.userId,
        tenantId: principal.tenantId,
        externalIdentity: `${principal.tenantId}:${principal.userId}`,
        email: `${principal.userId}@example.invalid`,
        status: "ACTIVE",
        createdAt: clock.now(),
      })
      .catch(() => undefined);
    await store.memberships
      .upsert({
        tenantId: principal.tenantId,
        userId: principal.userId,
        role,
        createdAt: clock.now(),
      })
      .catch(() => undefined);
  }

  /**
   * Ages the stored access token so the next upstream request has to refresh.
   * The refresh token is left intact, which is the situation the refresh
   * coordinator exists to handle.
   */
  async expireAccessToken(connectionId: string): Promise<void> {
    await this.services.store.connections.update(connectionId, {
      accessTokenExpiresAt: this.services.clock.now() - 1_000,
    });
  }

  /** Reads the plaintext refresh token, for assertions about rotation. */
  async storedRefreshToken(connectionId: string): Promise<string | null> {
    const connection = await this.services.store.connections.get(
      this.tenantId,
      connectionId,
    );
    if (!connection?.refreshTokenEncrypted) return null;
    return this.services.vault.decrypt(
      { tenantId: this.tenantId, purpose: "refresh_token" },
      connection.refreshTokenEncrypted,
    );
  }

  async accessToken(connectionId: string): Promise<string> {
    return this.services.tokenManager.getValidAccessToken({
      tenantId: this.tenantId,
      connectionId,
    });
  }

  async api(
    method: string,
    path: string,
    body?: unknown,
    apiKey = this.apiKey,
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    return {
      status: response.status,
      body: parsed,
      headers: Object.fromEntries(response.headers),
    };
  }

  async createConnection(
    mcpUrl: string,
    extra: Record<string, unknown> = {},
    apiKey = this.apiKey,
  ): Promise<ConnectionSummary> {
    const { status, body } = await this.api(
      "POST",
      "/api/v1/connections",
      { mcp_url: mcpUrl, ...extra },
      apiKey,
    );
    if (status !== 201) {
      throw new Error(`Creating a connection failed: ${status} ${JSON.stringify(body)}`);
    }
    return body as unknown as ConnectionSummary;
  }

  async listConnections(apiKey = this.apiKey): Promise<ConnectionSummary[]> {
    const { body } = await this.api("GET", "/api/v1/connections", undefined, apiKey);
    return (body["connections"] ?? []) as unknown as ConnectionSummary[];
  }

  async getConnection(id: string, apiKey = this.apiKey): Promise<ConnectionSummary> {
    const { body } = await this.api("GET", `/api/v1/connections/${id}`, undefined, apiKey);
    return body as unknown as ConnectionSummary;
  }

  async authorizeUrl(id: string, apiKey = this.apiKey): Promise<string> {
    const { status, body } = await this.api(
      "POST",
      `/api/v1/connections/${id}/authorize`,
      {},
      apiKey,
    );
    if (status !== 200) {
      throw new Error(`Starting authorization failed: ${status} ${JSON.stringify(body)}`);
    }
    return String(body["authorization_url"]);
  }
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
