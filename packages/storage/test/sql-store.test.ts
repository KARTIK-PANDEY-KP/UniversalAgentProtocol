import { afterAll, describe, expect, it } from "vitest";

import { newId, randomToken, type McpServerRecord, type UpstreamConnection } from "@uap/core";
import {
  PostgresDriver,
  SqlGatewayStore,
  SqliteDriver,
  createInMemoryStore,
  tlsFor,
  toDollarPlaceholders,
  type SqlDriver,
} from "@uap/storage";

/**
 * The point of the driver seam is that these two answer identically, which is
 * only demonstrated by asking them the same questions. Postgres is skipped
 * rather than failed when no server is configured, so a checkout with no
 * database still runs the SQLite half.
 */
const POSTGRES_URL = process.env["TEST_POSTGRES_URL"];

const drivers: { name: string; open: () => Promise<SqlGatewayStore> }[] = [
  { name: "sqlite", open: () => createInMemoryStore() },
];

const postgresDrivers: { driver: SqlDriver; schema: string }[] = [];
if (POSTGRES_URL) {
  drivers.push({
    name: "postgres",
    open: async () => {
      // A schema per store, because these tests use fixed ids and would
      // otherwise read each other's rows.
      const schema = `t_${randomToken(8).toLowerCase().replace(/[^a-z0-9]/gu, "")}`;
      const driver = new PostgresDriver({ connectionString: POSTGRES_URL, schema });
      postgresDrivers.push({ driver, schema });
      const store = new SqlGatewayStore(driver);
      await store.init();
      return store;
    },
  });
}

afterAll(async () => {
  // Seventeen tables apiece, left behind on every run against a database that
  // is usually not disposable.
  for (const { driver, schema } of postgresDrivers) {
    await driver.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []).catch(() => undefined);
    await driver.close().catch(() => undefined);
  }
});

async function seedServer(
  store: SqlGatewayStore,
  id = "srv_1",
): Promise<McpServerRecord> {
  const now = Date.now();
  return store.mcpServers.create({
    id,
    tenantId: "tenant_a",
    canonicalUrl: `https://mcp.example.com/${id}`,
    originalUrl: `https://mcp.example.com/${id}`,
    displayName: "Example",
    authorizationRequired: true,
    protectedResourceMetadataUrl: null,
    canonicalResource: `https://mcp.example.com/${id}`,
    selectedAuthorizationServer: null,
    transportType: "STREAMABLE_HTTP",
    protocolVersion: null,
    capabilitiesJson: null,
    metadataJson: null,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
}

function connection(overrides: Partial<UpstreamConnection> = {}): UpstreamConnection {
  const now = Date.now();
  return {
    id: newId("conn"),
    tenantId: "tenant_a",
    ownerType: "USER",
    ownerId: "user_1",
    mcpServerId: "srv_1",
    oauthIssuerId: null,
    oauthClientRegistrationId: null,
    alias: "example",
    grantedScopes: ["read"],
    requestedScopes: ["read"],
    accessTokenEncrypted: "enc-a1",
    refreshTokenEncrypted: "enc-r1",
    staticHeadersEncrypted: null,
    tokenType: "Bearer",
    accessTokenExpiresAt: now + 60_000,
    refreshTokenExpiresAt: null,
    tokenVersion: 1,
    dpopKeyReference: null,
    status: "CONNECTED",
    lastRefreshAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastErrorMessageRedacted: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe.each(drivers)("SqlGatewayStore on $name", ({ open }) => {
  it("round-trips a connection with JSON columns intact", async () => {
    const store = await open();
    await seedServer(store);
    const record = connection();
    await store.connections.create(record);

    const loaded = await store.connections.get("tenant_a", record.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.grantedScopes).toEqual(["read"]);
    expect(loaded?.tokenVersion).toBe(1);
  });

  it("keeps a millisecond timestamp intact rather than overflowing it", async () => {
    // Postgres INTEGER stops at 2^31, which a millisecond timestamp passed in
    // 1970 plus 24 days. The columns are BIGINT for this reason alone.
    const store = await open();
    await seedServer(store);
    const future = 4_102_444_800_000;
    const record = connection({ accessTokenExpiresAt: future });
    await store.connections.create(record);

    const loaded = await store.connections.get("tenant_a", record.id);
    expect(loaded?.accessTokenExpiresAt).toBe(future);
  });

  it("scopes reads by tenant", async () => {
    const store = await open();
    await seedServer(store);
    const record = connection();
    await store.connections.create(record);

    expect(await store.connections.get("tenant_b", record.id)).toBeNull();
  });

  it("accepts one compare-and-swap token update and rejects the stale one", async () => {
    const store = await open();
    await seedServer(store);
    const record = connection();
    await store.connections.create(record);

    const update = {
      connectionId: record.id,
      expectedTokenVersion: 1,
      accessTokenEncrypted: "enc-a2",
      refreshTokenEncrypted: "enc-r2",
      tokenType: "Bearer",
      accessTokenExpiresAt: Date.now() + 120_000,
      refreshTokenExpiresAt: null,
      grantedScopes: ["read", "write"],
      status: "CONNECTED" as const,
      lastRefreshAt: Date.now(),
    };

    expect(await store.connections.updateTokens(update)).toBe(true);
    expect(await store.connections.updateTokens(update)).toBe(false);

    const loaded = await store.connections.get("tenant_a", record.id);
    expect(loaded?.tokenVersion).toBe(2);
    expect(loaded?.accessTokenEncrypted).toBe("enc-a2");
    expect(loaded?.grantedScopes).toEqual(["read", "write"]);
  });

  it("consumes an authorization transaction exactly once", async () => {
    const store = await open();
    const id = newId("txn");
    await store.transactions.create({
      id,
      tenantId: "tenant_a",
      userId: "user_1",
      connectionId: "conn_1",
      issuer: "https://auth.example.com",
      stateHash: "hash",
      pkceVerifierEncrypted: "enc",
      redirectUri: "https://gateway.example.com/oauth/callback",
      requestedScopes: ["read"],
      resource: "https://mcp.example.com/mcp",
      expiresAt: Date.now() + 60_000,
      consumedAt: null,
      status: "PENDING",
      returnTo: null,
    });

    expect(await store.transactions.consume(id, Date.now())).toBe(true);
    expect(await store.transactions.consume(id, Date.now())).toBe(false);
  });

  it("reports added, changed and removed tools when syncing a catalogue", async () => {
    const store = await open();
    await seedServer(store);
    await store.connections.create(connection({ id: "conn_1" }));
    const base = {
      tenantId: "tenant_a",
      connectionId: "conn_1",
      description: null,
      outputSchemaJson: null,
      annotationsJson: null,
      enabled: true,
      riskLevel: "UNKNOWN" as const,
      discoveredAt: 1,
      lastSeenAt: 1,
    };

    const first = await store.tools.sync(
      "conn_1",
      [
        {
          ...base,
          id: newId("tool"),
          upstreamName: "search",
          gatewayName: "example.search",
          inputSchemaJson: { type: "object" },
          schemaHash: "hash-1",
        },
        {
          ...base,
          id: newId("tool"),
          upstreamName: "create",
          gatewayName: "example.create",
          inputSchemaJson: { type: "object" },
          schemaHash: "hash-2",
        },
      ],
      1,
    );
    expect(first.added.sort()).toEqual(["example.create", "example.search"]);

    const second = await store.tools.sync(
      "conn_1",
      [
        {
          ...base,
          id: newId("tool"),
          upstreamName: "search",
          gatewayName: "example.search",
          inputSchemaJson: { type: "object", properties: {} },
          schemaHash: "hash-1b",
        },
      ],
      2,
    );
    expect(second.changed).toEqual(["example.search"]);
    expect(second.removed).toEqual(["example.create"]);
  });

  it("serialises critical sections through the lease lock", async () => {
    const store = await open();
    const order: string[] = [];
    await Promise.all([
      store.locks.withLock("k", async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a-end");
      }),
      store.locks.withLock("k", async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("holds the lease for as long as the critical section runs", async () => {
    const store = await open();
    const leaseMs = 3_000;

    // Renewal fires at a third of the lease, so a section outliving one
    // interval is enough to tell a renewed lease from a lapsed one.
    await store.locks.withLock(
      "renewed",
      async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(signal.aborted).toBe(false);
      },
      { leaseMs, waitMs: 5_000 },
    );
  });

  it("gives up rather than queueing behind a lock forever", async () => {
    const store = await open();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = store.locks.withLock("busy", async () => held, { leaseMs: 10_000 });
    await expect(
      store.locks.withLock("busy", async () => "never", { waitMs: 50 }),
    ).rejects.toThrow(/lock busy/u);

    release();
    await holder;
  });
});

describe("the two drivers agree on what they were asked", () => {
  it("rewrites placeholders positionally, and only placeholders", () => {
    expect(toDollarPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
    expect(toDollarPlaceholders("SELECT * FROM t")).toBe("SELECT * FROM t");
  });

  it("decides TLS itself rather than leaving it to the driver's own reading", () => {
    // node-postgres reads `require` as verify-full and lets that win over an
    // explicit setting, so the parameter has to be gone by the time it looks.
    const required = tlsFor("postgres://u:p@h:5432/d?sslmode=require");
    expect(required.connectionString).not.toContain("sslmode");
    expect(required.ssl).toEqual({ rejectUnauthorized: false });

    expect(tlsFor("postgres://u:p@h:5432/d?sslmode=verify-full").ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(tlsFor("postgres://u:p@h:5432/d?sslmode=disable").ssl).toBe(false);
    expect(tlsFor("postgres://u:p@h:5432/d").ssl).toBe(false);
    expect(() => tlsFor("postgres://u:p@h:5432/d?sslmode=sideways")).toThrow(/Unknown sslmode/u);
  });

  it("keeps every other connection parameter while removing the TLS ones", () => {
    const { connectionString } = tlsFor(
      "postgres://u:p@h:5432/d?sslmode=require&application_name=uap",
    );
    expect(connectionString).toContain("application_name=uap");
    expect(connectionString).toContain("u:p@h:5432/d");
  });

  it("refuses a schema name that would need quoting to be safe", () => {
    expect(
      () => new PostgresDriver({ connectionString: "postgres://x/y", schema: 'a"; DROP' }),
    ).toThrow(/Unsafe Postgres schema name/u);
  });

  it("keeps a sqlite driver private to its own store", async () => {
    const a = new SqliteDriver({ filename: ":memory:" });
    const b = new SqliteDriver({ filename: ":memory:" });
    const first = new SqlGatewayStore(a);
    const second = new SqlGatewayStore(b);
    await first.init();
    await second.init();
    await first.tenants.create({
      id: "t1",
      name: "one",
      status: "ACTIVE",
      createdAt: Date.now(),
    });
    expect(await second.tenants.get("t1")).toBeNull();
    await first.close();
    await second.close();
  });
});
