import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "@uap/core";
import {
  BackgroundWorker,
  DEFAULT_BACKGROUND_CONFIG,
  type GatewayConfig,
} from "@uap/gateway";
import { LocalKeyring } from "@uap/security";
import {
  GatewayFixture,
  GatewayMcpClient,
  MockMcpServer,
  connectUpstream,
  startProtectedUpstream,
} from "@uap/conformance";

/**
 * The worker keeps connections usable between requests. It shares the token
 * manager's lock and compare-and-swap, so a scheduled pass and live traffic
 * must never rotate a refresh token twice.
 */
describe("background worker", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function newGateway(config: Partial<GatewayConfig> = {}): Promise<GatewayFixture> {
    const gateway = new GatewayFixture({ config });
    await gateway.start();
    started.push(gateway);
    return gateway;
  }

  function workerFor(
    gateway: GatewayFixture,
    overrides: Partial<typeof DEFAULT_BACKGROUND_CONFIG> = {},
  ): BackgroundWorker {
    return new BackgroundWorker(gateway.services, {
      ...DEFAULT_BACKGROUND_CONFIG,
      ...overrides,
    });
  }

  it("renews an access token before it expires", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, accessTokenTtlSeconds: 120 },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const before = await gateway.accessToken(connection.connection_id);

    // The token is valid for two minutes and the horizon reaches five.
    const report = await workerFor(gateway).refreshExpiringTokens();
    expect(report).toMatchObject({ name: "refresh_tokens", processed: 1, failed: 0 });
    expect(upstream.authorizationServer.stats.refreshes).toBe(1);
    expect(await gateway.accessToken(connection.connection_id)).not.toBe(before);
    expect(upstream.authorizationServer.activeRefreshTokens()).toHaveLength(1);
  });

  it("leaves a token that is nowhere near expiry alone", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, accessTokenTtlSeconds: 3600 },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const report = await workerFor(gateway).refreshExpiringTokens();
    expect(report.processed).toBe(0);
    expect(upstream.authorizationServer.stats.refreshes).toBe(0);
  });

  it("does not race a concurrent on-demand refresh", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, rotateRefreshToken: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    upstream.authorizationServer.delayTokenResponses(20);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    await gateway.expireAccessToken(connection.connection_id);

    const worker = workerFor(gateway);
    await Promise.all([
      worker.refreshExpiringTokens(),
      worker.refreshExpiringTokens(),
      gateway.accessToken(connection.connection_id),
      gateway.accessToken(connection.connection_id),
    ]);

    expect(upstream.authorizationServer.stats.refreshes).toBe(1);
    const stored = await gateway.storedRefreshToken(connection.connection_id);
    expect(upstream.authorizationServer.activeRefreshTokens()).toEqual([stored]);
  });

  it("keeps going when one connection cannot be refreshed", async () => {
    const healthy = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, accessTokenTtlSeconds: 120 },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(healthy);
    const revoked = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, accessTokenTtlSeconds: 120 },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(revoked);

    const gateway = await newGateway();
    await connectUpstream(gateway, healthy.url, { alias: "healthy" });
    const broken = await connectUpstream(gateway, revoked.url, { alias: "revoked" });
    revoked.authorizationServer.revokeAllGrants();

    const report = await workerFor(gateway).refreshExpiringTokens();
    expect(report.processed).toBe(2);
    expect(report.failed).toBe(1);
    expect(healthy.authorizationServer.stats.refreshes).toBe(1);
    expect((await gateway.getConnection(broken.connection.connection_id)).status).toBe(
      "REAUTH_REQUIRED",
    );
  });

  it("picks up tools an upstream added since the last sync", async () => {
    const server = new MockMcpServer({ requireAuth: false, tools: [{ name: "list_one" }] });
    await server.start();
    started.push(server);
    const gateway = await newGateway();
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    expect(await client.listTools()).toHaveLength(1);

    server.setTools([{ name: "list_one" }, { name: "list_two" }]);
    const report = await workerFor(gateway, { catalogueIntervalMs: 0 }).resyncCatalogues();

    expect(report).toMatchObject({ name: "resync_catalogues", processed: 1, failed: 0 });
    expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
      "up.list_one",
      "up.list_two",
    ]);
    expect((await gateway.getConnection(connection.connection_id)).tool_count).toBe(2);
    await client.close();
  });

  it("degrades one unreachable connection without abandoning the rest", async () => {
    const healthy = new MockMcpServer({ requireAuth: false, tools: [{ name: "list_ok" }] });
    await healthy.start();
    started.push(healthy);
    const flaky = new MockMcpServer({ requireAuth: false, tools: [{ name: "list_flaky" }] });
    await flaky.start();
    started.push(flaky);

    const gateway = await newGateway();
    await gateway.createConnection(healthy.url, { alias: "healthy" });
    const broken = await gateway.createConnection(flaky.url, { alias: "flaky" });
    flaky.failNextRequests(20, 503);

    const report = await workerFor(gateway, { catalogueIntervalMs: 0 }).resyncCatalogues();
    expect(report.processed).toBe(2);
    expect(report.failed).toBe(1);
    expect((await gateway.getConnection(broken.connection_id)).status).toBe("DEGRADED");
  });

  it("closes a downstream session that has gone idle", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    await client.callTool("up.ping");
    const sessionId = client.session ?? "";
    expect(gateway.services.northbound.sessionCount).toBe(1);
    expect(gateway.services.upstreamSessions.size).toBeGreaterThan(0);

    // A generous idle window leaves a session that was just used alone.
    expect((await workerFor(gateway).reapSessions()).processed).toBe(0);
    expect(gateway.services.northbound.sessionCount).toBe(1);

    const report = await workerFor(gateway, { sessionIdleMs: 0 }).reapSessions();
    expect(report).toMatchObject({ name: "reap_sessions", failed: 0 });
    expect(gateway.services.northbound.sessionCount).toBe(0);
    expect(gateway.services.upstreamSessions.size).toBe(0);
    expect(
      (await gateway.services.store.downstreamSessions.get(sessionId))?.status,
    ).toBe("CLOSED");
  });

  it("purges an authorization the user started and never finished", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    // Short enough that the abandoned transaction ages out inside the test.
    const gateway = await newGateway({ authorizationTransactionTtlMs: 40 });

    // Creating the connection already opens the one transaction the user
    // would have finished in the browser.
    const pending = await gateway.createConnection(upstream.url, { alias: "pending" });
    expect(pending.status).toBe("AUTHORIZATION_REQUIRED");
    const authorizationUrl = new URL(pending.authorization_url ?? "");
    const stateHash = sha256Hex(authorizationUrl.searchParams.get("state") ?? "");
    expect(await gateway.services.store.transactions.findByStateHash(stateHash)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 60));
    const report = await workerFor(gateway).reapSessions();

    expect(report.processed).toBe(1);
    expect(await gateway.services.store.transactions.findByStateHash(stateHash)).toBeNull();
    // Purging the transaction does not touch the connection the user may
    // still come back and authorize.
    expect((await gateway.getConnection(pending.connection_id)).status).toBe(
      "AUTHORIZATION_REQUIRED",
    );
  });

  it("moves credentials onto a newly rotated encryption key", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);

    // A deployment that boots on one key and is later rotated onto another.
    const firstKey = randomBytes(32).toString("base64");
    const gateway = await newGateway({ encryptionKeyRing: `key-1:${firstKey}` });
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const accessToken = await gateway.accessToken(connection.connection_id);
    const before = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );
    expect(before?.accessTokenEncrypted?.startsWith("v1.key-1.")).toBe(true);

    const secondKey = randomBytes(32).toString("base64");
    // The retired key stays in the ring so existing ciphertext keeps opening.
    gateway.services.vault.rotateKeyring(
      LocalKeyring.fromSpec(`key-2:${secondKey},key-1:${firstKey}`),
    );

    const report = await workerFor(gateway).rewrapCredentials();
    expect(report).toMatchObject({ name: "rewrap_credentials", processed: 1, failed: 0 });

    const after = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );
    expect(after?.accessTokenEncrypted?.startsWith("v1.key-2.")).toBe(true);
    expect(after?.refreshTokenEncrypted?.startsWith("v1.key-2.")).toBe(true);
    // Rewrapping changes the envelope, never the secret or the token version.
    expect(await gateway.accessToken(connection.connection_id)).toBe(accessToken);
    expect(after?.tokenVersion).toBe(before?.tokenVersion);

    // A second pass has nothing left to do.
    expect((await workerFor(gateway).rewrapCredentials()).processed).toBe(0);
  });

  it("reports every job when run once", async () => {
    const gateway = await newGateway();
    const reports = await workerFor(gateway).runOnce();
    expect(reports.map((report) => report.name)).toEqual([
      "refresh_tokens",
      "resync_catalogues",
      "reap_sessions",
      "rewrap_credentials",
    ]);
    expect(reports.every((report) => report.failed === 0)).toBe(true);
    expect(gateway.services.metrics.render()).toContain("background_job_run_total");
  });
});
