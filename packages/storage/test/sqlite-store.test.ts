import { describe, expect, it } from "vitest";

import { newId, type McpServerRecord, type UpstreamConnection } from "@umg/core";
import { createInMemoryStore, type SqliteGatewayStore } from "@umg/storage";

async function seedServer(
  store: SqliteGatewayStore,
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

describe("SqliteGatewayStore", () => {
  it("round-trips a connection with JSON columns intact", async () => {
    const store = createInMemoryStore();
    await seedServer(store);
    const record = connection();
    await store.connections.create(record);

    const loaded = await store.connections.get("tenant_a", record.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.grantedScopes).toEqual(["read"]);
    expect(loaded?.tokenVersion).toBe(1);
    store.close();
  });

  it("scopes reads by tenant", async () => {
    const store = createInMemoryStore();
    await seedServer(store);
    const record = connection();
    await store.connections.create(record);

    expect(await store.connections.get("tenant_b", record.id)).toBeNull();
    store.close();
  });

  it("accepts one compare-and-swap token update and rejects the stale one", async () => {
    const store = createInMemoryStore();
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
    store.close();
  });

  it("consumes an authorization transaction exactly once", async () => {
    const store = createInMemoryStore();
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
    store.close();
  });

  it("reports added, changed and removed tools when syncing a catalogue", async () => {
    const store = createInMemoryStore();
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
    store.close();
  });

  it("serialises critical sections through the lease lock", async () => {
    const store = createInMemoryStore();
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
    store.close();
  });

  it("holds the lease for as long as the critical section runs", async () => {
    const store = createInMemoryStore();
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

    store.close();
  });

  it("gives up rather than queueing behind a lock forever", async () => {
    const store = createInMemoryStore();
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
    store.close();
  });
});
