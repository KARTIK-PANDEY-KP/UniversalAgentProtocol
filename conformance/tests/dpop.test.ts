import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayFixture,
  GatewayMcpClient,
  connectUpstream,
  startProtectedUpstream,
  thumbprintOf,
  type ProtectedUpstream,
} from "@uap/conformance";

/**
 * RFC 9449. The gateway holds a lot of other people's tokens, so where an
 * authorization server offers to bind them to a key, a stolen token should be
 * worth nothing on its own. These tests check that the binding is real by
 * replaying tokens the way an attacker would.
 */
describe("DPoP sender-constrained tokens", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function scenario(
    options: {
      requireDpopNonceAtToken?: boolean;
      requireDpopNonceAtResource?: boolean;
      supportsDpop?: boolean;
    } = {},
  ): Promise<{ gateway: GatewayFixture; upstream: ProtectedUpstream }> {
    const upstream = await startProtectedUpstream({
      authorizationServer: {
        supportsDcr: true,
        supportsDpop: options.supportsDpop ?? true,
        requireDpopNonce: options.requireDpopNonceAtToken ?? false,
      },
      mcpServer: {
        tools: [{ name: "ping" }],
        requireDpopNonce: options.requireDpopNonceAtResource ?? false,
      },
    });
    started.push(upstream);
    const gateway = new GatewayFixture();
    await gateway.start();
    started.push(gateway);
    return { gateway, upstream };
  }

  async function callPing(gateway: GatewayFixture, alias: string): Promise<void> {
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    expect(await client.callTool(`${alias}.ping`)).toBeDefined();
    await client.close();
  }

  it("binds the token to a key it generated when the server advertises DPoP", async () => {
    const { gateway, upstream } = await scenario();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    expect(connection.status).toBe("CONNECTED");

    const record = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );
    expect(record?.tokenType).toBe("DPoP");
    expect(record?.dpopKeyReference).toBeTruthy();

    // The token the server minted is bound to the public key the gateway
    // stored, which is what makes the token useless to anyone else.
    const key = await gateway.services.store.dpopKeys.get(record?.dpopKeyReference ?? "");
    const introspected = upstream.authorizationServer.introspect(
      await gateway.accessToken(connection.connection_id),
    );
    expect(introspected.confirmation).toBe(
      thumbprintOf((key?.publicJwkJson ?? {}) as Record<string, unknown>),
    );

    await callPing(gateway, "up");
  });

  it("presents the token as DPoP, not Bearer, on every upstream request", async () => {
    const { gateway, upstream } = await scenario();
    await connectUpstream(gateway, upstream.url, { alias: "up" });
    await callPing(gateway, "up");

    const schemes = new Set(
      upstream.mcpServer.stats.authorizationHeadersSeen.map(
        (header) => header.split(" ")[0],
      ),
    );
    expect([...schemes]).toEqual(["DPoP"]);
  });

  it("stays on bearer tokens when the server does not advertise DPoP", async () => {
    const { gateway, upstream } = await scenario({ supportsDpop: false });
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    const record = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );
    expect(record?.tokenType).toBe("Bearer");
    expect(record?.dpopKeyReference).toBeNull();
    await callPing(gateway, "up");
  });

  it("retries with the nonce the token endpoint demands", async () => {
    const { gateway, upstream } = await scenario({ requireDpopNonceAtToken: true });
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    expect(connection.status).toBe("CONNECTED");
    // The first request was spent learning the nonce; the retry carried it.
    expect(upstream.authorizationServer.stats.tokenRequests).toBe(2);
    expect(upstream.authorizationServer.stats.codeExchanges).toBe(1);
    await callPing(gateway, "up");
  });

  it("retries with the nonce the resource server demands", async () => {
    const { gateway, upstream } = await scenario({ requireDpopNonceAtResource: true });
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    expect(connection.status).toBe("CONNECTED");
    await callPing(gateway, "up");
  });

  it("keeps using the same key across a refresh", async () => {
    const { gateway, upstream } = await scenario();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const before = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );

    await gateway.expireAccessToken(connection.connection_id);
    await callPing(gateway, "up");

    expect(upstream.authorizationServer.stats.refreshes).toBe(1);
    const after = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );
    // A new key would invalidate every proof the gateway had already made, so
    // the binding key outlives the token it was minted with.
    expect(after?.dpopKeyReference).toBe(before?.dpopKeyReference);
    expect(after?.tokenType).toBe("DPoP");
  });

  it("refuses a bound token replayed as a bearer token", async () => {
    const { gateway, upstream } = await scenario();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    const stolen = await gateway.accessToken(connection.connection_id);

    const response = await fetch(upstream.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stolen}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    // No proof, no access: the token alone is not a credential any more.
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: "invalid_dpop_proof",
    });
  });
});
