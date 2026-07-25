import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayFixture,
  GatewayMcpClient,
  connectUpstream,
  startProtectedUpstream,
} from "@uap/conformance";

/**
 * Section 19.4: the gateway is the sole owner of the upstream refresh token,
 * so every downstream client racing on an expired access token must collapse
 * onto exactly one provider refresh and observe the same rotated credential.
 */
describe("token refresh concurrency", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function newGateway(): Promise<GatewayFixture> {
    const gateway = new GatewayFixture();
    await gateway.start();
    started.push(gateway);
    return gateway;
  }

  it("collapses a hundred concurrent refreshes onto one provider call", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: {
        supportsDcr: true,
        rotateRefreshToken: true,
        // A slow token endpoint widens the window every racing caller must
        // survive; without a lock this test would see many refreshes.
        accessTokenTtlSeconds: 3600,
      },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    upstream.authorizationServer.delayTokenResponses(25);

    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const before = upstream.authorizationServer.stats.refreshes;
    const originalRefreshToken = await gateway.storedRefreshToken(connection.connection_id);
    expect(originalRefreshToken).toBeTypeOf("string");

    await gateway.expireAccessToken(connection.connection_id);
    const tokens = await Promise.all(
      Array.from({ length: 100 }, () => gateway.accessToken(connection.connection_id)),
    );

    expect(upstream.authorizationServer.stats.refreshes - before).toBe(1);
    expect(new Set(tokens).size).toBe(1);

    const rotated = await gateway.storedRefreshToken(connection.connection_id);
    expect(rotated).not.toBe(originalRefreshToken);
    expect(upstream.authorizationServer.activeRefreshTokens()).toEqual([rotated]);
    expect(upstream.authorizationServer.isRefreshTokenActive(originalRefreshToken!)).toBe(
      false,
    );
  });

  it("refreshes once for concurrent tool calls from several downstream clients", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, rotateRefreshToken: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    // Three separate MCP hosts, exactly as Cursor, Claude Code and Codex would
    // appear: distinct downstream sessions over one upstream grant.
    const clients = await Promise.all(
      ["cursor", "claude-code", "codex"].map(async (name) => {
        const client = new GatewayMcpClient({
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          clientInfo: { name, version: "1.0.0" },
        });
        await client.initialize();
        return client;
      }),
    );
    expect(new Set(clients.map((client) => client.session)).size).toBe(3);

    const before = upstream.authorizationServer.stats.refreshes;
    await gateway.expireAccessToken(connection.connection_id);

    const results = await Promise.all(
      Array.from({ length: 30 }, (_unused, index) =>
        clients[index % clients.length]!.callTool("up.ping"),
      ),
    );

    expect(results).toHaveLength(30);
    expect(upstream.authorizationServer.stats.refreshes - before).toBe(1);
    // Every upstream request after the refresh carried the new access token.
    const current = await gateway.accessToken(connection.connection_id);
    const seen = upstream.mcpServer.stats.authorizationHeadersSeen;
    expect(seen.at(-1)).toBe(`Bearer ${current}`);

    for (const client of clients) await client.close();
  });

  it("keeps the refresh token when the provider fails transiently", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const before = await gateway.storedRefreshToken(connection.connection_id);

    await gateway.expireAccessToken(connection.connection_id);
    // More failures than the retry budget, so the refresh gives up.
    upstream.authorizationServer.failNextTokenRequests({
      count: 5,
      status: 503,
      error: "temporarily_unavailable",
    });

    const failure = await gateway
      .accessToken(connection.connection_id)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);

    const view = await gateway.getConnection(connection.connection_id);
    // A network blip is not consent revocation: the grant must survive.
    expect(view.status).toBe("DEGRADED");
    expect(await gateway.storedRefreshToken(connection.connection_id)).toBe(before);

    // Once the provider recovers the same refresh token still works.
    const recovered = await gateway.accessToken(connection.connection_id);
    expect(recovered).toBeTypeOf("string");
    expect((await gateway.getConnection(connection.connection_id)).status).toBe(
      "CONNECTED",
    );
  });

  it("requires reauthorization when the grant is revoked, without leaking credentials", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    upstream.authorizationServer.revokeAllGrants();
    await gateway.expireAccessToken(connection.connection_id);

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    const failure = await client.callTool("up.ping").catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    const data = JSON.stringify((failure as { data?: unknown }).data ?? {});
    expect(data).toContain("reconnect_url");
    expect(data).not.toContain("rt_");
    expect(data).not.toContain("at_");

    const view = await gateway.getConnection(connection.connection_id);
    expect(view.status).toBe("REAUTH_REQUIRED");
    expect(view.connect_url).toContain(`/connect/${connection.connection_id}`);
    await client.close();
  });

  it("stops hammering a failing authorization server", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    upstream.authorizationServer.failNextTokenRequests({
      count: 1000,
      status: 503,
      error: "temporarily_unavailable",
    });

    let requestsAtTrip = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await gateway.expireAccessToken(connection.connection_id);
      const error = await gateway
        .accessToken(connection.connection_id)
        .catch((cause: Error) => cause);
      if ((error as Error).message.includes("temporarily disabled")) {
        requestsAtTrip = upstream.authorizationServer.stats.tokenRequests;
        break;
      }
    }

    expect(requestsAtTrip).toBeGreaterThan(0);
    // Once the breaker is open no further provider requests are made.
    await gateway.accessToken(connection.connection_id).catch(() => undefined);
    expect(upstream.authorizationServer.stats.tokenRequests).toBe(requestsAtTrip);
  });

  it("marks a connection non-refreshable when the provider issues no refresh token", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true, issueRefreshToken: false },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    expect(connection.status).toBe("CONNECTED_NON_REFRESHABLE");
    expect(await gateway.storedRefreshToken(connection.connection_id)).toBeNull();

    // It still works until the access token expires.
    expect(await gateway.accessToken(connection.connection_id)).toBeTypeOf("string");

    await gateway.expireAccessToken(connection.connection_id);
    const failure = await gateway
      .accessToken(connection.connection_id)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((await gateway.getConnection(connection.connection_id)).status).toBe(
      "REAUTH_REQUIRED",
    );
    expect(upstream.authorizationServer.stats.refreshes).toBe(0);
  });

  it("reuses a still-valid access token instead of refreshing", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    const before = upstream.authorizationServer.stats.tokenRequests;
    const tokens = await Promise.all(
      Array.from({ length: 25 }, () => gateway.accessToken(connection.connection_id)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(upstream.authorizationServer.stats.tokenRequests).toBe(before);
  });

  it("revoking a connection retires the refresh token at the provider", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const refreshToken = await gateway.storedRefreshToken(connection.connection_id);

    const { status } = await gateway.api(
      "DELETE",
      `/api/v1/connections/${connection.connection_id}`,
    );
    expect(status).toBe(204);
    expect(upstream.authorizationServer.stats.revocations).toBe(1);
    expect(upstream.authorizationServer.isRefreshTokenActive(refreshToken!)).toBe(false);
  });
});
