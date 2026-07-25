import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayFixture,
  GatewayMcpClient,
  MockIdentityProvider,
  MockMcpServer,
} from "@umg/conformance";

/**
 * Section 12: the gateway advertises itself as an OAuth protected resource, so
 * a token minted by an authorization server the operator trusts has to work in
 * place of a gateway API key, and everything else has to be turned away with a
 * challenge that says why.
 */
describe("gateway authentication", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function scenario(
    options: {
      provider?: ConstructorParameters<typeof MockIdentityProvider>[0];
      gateway?: ConstructorParameters<typeof GatewayFixture>[0];
    } = {},
  ): Promise<{
    gateway: GatewayFixture;
    provider: MockIdentityProvider;
    resource: string;
  }> {
    const provider = new MockIdentityProvider(options.provider ?? {});
    await provider.start();
    started.push(provider);

    const gateway = new GatewayFixture({
      ...(options.gateway ?? {}),
      config: {
        gatewayAuthorizationServers: [provider.issuer],
        ...(options.gateway?.config ?? {}),
      },
    });
    await gateway.start();
    started.push(gateway);

    return { gateway, provider, resource: `${gateway.baseUrl}/mcp` };
  }

  /** Opens a session, which is the first thing any credential has to survive. */
  async function mcp(
    gateway: GatewayFixture,
    token: string,
  ): Promise<{ status: number; body: Record<string, unknown>; challenge: string }> {
    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "conformance", version: "1.0.0" },
        },
      }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
      challenge: response.headers.get("www-authenticate") ?? "",
    };
  }

  it("accepts a token its authorization server signed for this gateway", async () => {
    const { gateway, provider, resource } = await scenario();
    const server = new MockMcpServer({ requireAuth: false, tools: [{ name: "ping" }] });
    await server.start();
    started.push(server);
    await gateway.createConnection(server.url, {
      alias: "up",
      owner_type: "WORKSPACE",
    });

    const token = provider.issueToken({
      subject: "alice",
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });

    const client = new GatewayMcpClient({ baseUrl: gateway.baseUrl, apiKey: token });
    await client.initialize();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["up.ping"]);
    expect(await client.callTool("up.ping")).toBeDefined();
    await client.close();
  });

  it("creates the workspace member the first time a subject appears", async () => {
    const { gateway, provider, resource } = await scenario();
    const token = provider.issueToken({
      subject: "carol",
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: "tenant_from_token", roles: ["maintainer"] },
    });

    const response = await fetch(`${gateway.baseUrl}/api/v1/connections`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const userId = `${new URL(provider.issuer).host}:carol`;
    const membership = await gateway.services.store.memberships.get(
      "tenant_from_token",
      userId,
    );
    expect(membership?.role).toBe("maintainer");
    // The subject is namespaced by issuer so two providers cannot collide.
    expect(await gateway.services.store.users.get("tenant_from_token", userId)).not.toBeNull();
  });

  it("keeps two tenants' catalogues apart when both arrive as tokens", async () => {
    const { gateway, provider, resource } = await scenario();
    const first = new MockMcpServer({ requireAuth: false, tools: [{ name: "one" }] });
    const second = new MockMcpServer({ requireAuth: false, tools: [{ name: "two" }] });
    await first.start();
    await second.start();
    started.push(first, second);

    const tokenFor = (tenant: string): string =>
      provider.issueToken({
        subject: `user-${tenant}`,
        audience: resource,
        scope: "mcp",
        claims: { tenant_id: tenant },
      });

    const create = async (token: string, url: string, alias: string): Promise<void> => {
      const response = await fetch(`${gateway.baseUrl}/api/v1/connections`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mcp_url: url, alias }),
      });
      expect(response.status).toBe(201);
    };

    const alpha = tokenFor("tenant_alpha");
    const beta = tokenFor("tenant_beta");
    await create(alpha, first.url, "alpha");
    await create(beta, second.url, "beta");

    const alphaClient = new GatewayMcpClient({ baseUrl: gateway.baseUrl, apiKey: alpha });
    await alphaClient.initialize();
    expect((await alphaClient.listTools()).map((tool) => tool.name)).toEqual(["alpha.one"]);
    await alphaClient.close();
  });

  it("refuses a token minted for a different resource", async () => {
    const { gateway, provider } = await scenario();
    const token = provider.issueToken({
      audience: "https://someone-elses-api.example.com",
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });

    const { status, body, challenge } = await mcp(gateway, token);
    expect(status).toBe(401);
    expect(body["error"]).toBe("invalid_token");
    expect(challenge).toContain('error="invalid_token"');
    // The client is still told where to go and get a usable token.
    expect(challenge).toContain("resource_metadata=");
  });

  it("refuses a token signed with a key the issuer does not publish", async () => {
    const { gateway, provider, resource } = await scenario();
    const token = provider.issueToken({
      audience: resource,
      scope: "mcp",
      signWithForeignKey: true,
      claims: { tenant_id: gateway.tenantId },
    });

    const { status, body } = await mcp(gateway, token);
    expect(status).toBe(401);
    expect(String(body["error_description"])).toMatch(/signature/u);
  });

  it("refuses a token that claims an issuer the operator never configured", async () => {
    const { gateway, provider, resource } = await scenario();
    const token = provider.issueToken({
      issuer: "https://attacker.example.com",
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });

    const { status, body } = await mcp(gateway, token);
    expect(status).toBe(401);
    expect(String(body["error_description"])).toMatch(/not accepted/u);
  });

  it("refuses an unsigned token however plausible its claims look", async () => {
    const { gateway, provider, resource } = await scenario();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const claims = Buffer.from(
      JSON.stringify({
        iss: provider.issuer,
        sub: "mallory",
        aud: resource,
        scope: "mcp",
        exp: Math.floor(Date.now() / 1000) + 3600,
        tenant_id: gateway.tenantId,
      }),
    ).toString("base64url");

    const { status, body } = await mcp(gateway, `${header}.${claims}.`);
    expect(status).toBe(401);
    expect(String(body["error_description"])).toMatch(/algorithm/u);
  });

  it("refuses an expired token", async () => {
    const { gateway, provider, resource } = await scenario();
    const token = provider.issueToken({
      audience: resource,
      scope: "mcp",
      expiresInSeconds: -600,
      claims: { tenant_id: gateway.tenantId },
    });

    const { status, body } = await mcp(gateway, token);
    expect(status).toBe(401);
    expect(String(body["error_description"])).toMatch(/expired/u);
  });

  it("refuses a token with no expiry at all", async () => {
    const { gateway, provider, resource } = await scenario();
    const token = provider.issueToken({
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId, exp: undefined },
    });

    const { status, body } = await mcp(gateway, token);
    expect(status).toBe(401);
    expect(String(body["error_description"])).toMatch(/no expiry/u);
  });

  it("asks for a wider scope rather than pretending the token is unreadable", async () => {
    const { gateway, provider, resource } = await scenario({
      gateway: { config: { gatewayRequiredScopes: ["mcp"] } },
    });
    const token = provider.issueToken({
      audience: resource,
      scope: "profile",
      claims: { tenant_id: gateway.tenantId },
    });

    const { status, body, challenge } = await mcp(gateway, token);
    expect(status).toBe(403);
    expect(body["error"]).toBe("insufficient_scope");
    expect(challenge).toContain('scope="mcp"');
  });

  it("follows a key rotation without waiting for a cache to expire", async () => {
    const { gateway, provider, resource } = await scenario();
    const before = provider.issueToken({
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });
    expect((await mcp(gateway, before)).status).toBe(200);

    provider.rotateKey();
    const after = provider.issueToken({
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });
    expect((await mcp(gateway, after)).status).toBe(200);
    // The old token stops working because its key is no longer published.
    expect((await mcp(gateway, before)).status).toBe(401);
  });

  it("will not refetch the key set once per invented key id", async () => {
    const { gateway, provider, resource } = await scenario();
    const good = provider.issueToken({
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });
    expect((await mcp(gateway, good)).status).toBe(200);
    expect(provider.jwksRequests).toBe(1);

    // Unknown key ids are how a rotation looks, so the first one is chased.
    // Chasing all of them would make an unauthenticated caller a lever on the
    // operator's authorization server.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const forged = provider.issueToken({
        audience: resource,
        scope: "mcp",
        keyId: `invented-${attempt}`,
        claims: { tenant_id: gateway.tenantId },
      });
      expect((await mcp(gateway, forged)).status).toBe(401);
    }
    expect(provider.jwksRequests).toBe(2);
  });

  it("refuses a JWT the issuer signed for some other purpose", async () => {
    const { gateway, provider, resource } = await scenario();
    // A DPoP proof is a JWT the same issuer's ecosystem produces. It is not an
    // access token, and it says so in its own header.
    const token = provider.issueToken({
      audience: resource,
      scope: "mcp",
      type: "dpop+jwt",
      claims: { tenant_id: gateway.tenantId },
    });

    const { status, body } = await mcp(gateway, token);
    expect(status).toBe(401);
    expect(String(body["error_description"])).toContain("not an access token");
  });

  it("caches the key set instead of refetching it per request", async () => {
    const { gateway, provider, resource } = await scenario();
    const token = provider.issueToken({
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await mcp(gateway, token)).status).toBe(200);
    }
    expect(provider.jwksRequests).toBe(1);
  });

  it("verifies an elliptic curve signature as readily as an RSA one", async () => {
    const { gateway, provider, resource } = await scenario({
      provider: { algorithm: "ES256" },
    });
    const token = provider.issueToken({
      audience: resource,
      scope: "mcp",
      claims: { tenant_id: gateway.tenantId },
    });
    expect((await mcp(gateway, token)).status).toBe(200);
  });

  it("still accepts an API key when an authorization server is configured", async () => {
    const { gateway } = await scenario();
    const { status } = await gateway.api("GET", "/api/v1/connections");
    expect(status).toBe(200);
  });

  it("does not try to verify tokens when no authorization server is configured", async () => {
    const gateway = new GatewayFixture();
    await gateway.start();
    started.push(gateway);

    const { status, challenge } = await mcp(gateway, "not-a-real-key");
    expect(status).toBe(401);
    // Nothing to say beyond "log in", because there is no issuer to appeal to.
    expect(challenge).not.toContain("error=");
    expect(challenge).toContain("resource_metadata=");
  });

  it("advertises the issuers it will actually accept", async () => {
    const { gateway, provider } = await scenario();
    const response = await fetch(
      `${gateway.baseUrl}/.well-known/oauth-protected-resource`,
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["authorization_servers"]).toEqual([provider.issuer]);
    expect(body["resource"]).toBe(`${gateway.baseUrl}/mcp`);
  });
});
