import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayFixture,
  connectUpstream,
  startProtectedUpstream,
  type ProtectedUpstream,
} from "@umg/conformance";
import type { MockAuthorizationServerOptions } from "@umg/conformance";

/**
 * Section 19.1 of the brief: the gateway must obtain a client identity from
 * every registration mechanism a standards-compliant authorization server may
 * offer, using the same generic code path each time.
 */
describe("OAuth client registration", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function scenario(
    authorizationServer: MockAuthorizationServerOptions,
  ): Promise<{ gateway: GatewayFixture; upstream: ProtectedUpstream }> {
    const upstream = await startProtectedUpstream({
      authorizationServer,
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = new GatewayFixture();
    await gateway.start();
    started.push(gateway);
    return { gateway, upstream };
  }

  it("uses dynamic client registration when the server offers only DCR", async () => {
    const { gateway, upstream } = await scenario({ supportsDcr: true });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED");
    expect(upstream.authorizationServer.stats.registrations).toBe(1);

    const registration = await registrationOf(gateway);
    expect(registration.registrationType).toBe("DYNAMIC");
    expect(registration.clientId).toMatch(/^dcr_/u);
  });

  it("uses its own metadata document when the server supports CIMD", async () => {
    const { gateway, upstream } = await scenario({ supportsCimd: true });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED");
    expect(upstream.authorizationServer.stats.registrations).toBe(0);

    const registration = await registrationOf(gateway);
    expect(registration.registrationType).toBe("CIMD");
    expect(registration.clientId).toBe(`${gateway.baseUrl}/oauth/client-metadata.json`);

    // The document the authorization server fetched must be self-consistent.
    const document = (await (
      await fetch(registration.clientId)
    ).json()) as Record<string, unknown>;
    expect(document["client_id"]).toBe(registration.clientId);
    expect(document["redirect_uris"]).toEqual([`${gateway.baseUrl}/oauth/callback`]);
  });

  it("prefers CIMD over DCR when both are advertised", async () => {
    const { gateway, upstream } = await scenario({
      supportsCimd: true,
      supportsDcr: true,
    });
    await connectUpstream(gateway, upstream.url);

    expect(upstream.authorizationServer.stats.registrations).toBe(0);
    expect((await registrationOf(gateway)).registrationType).toBe("CIMD");
  });

  it("authenticates with private_key_jwt when the server supports it", async () => {
    const { gateway, upstream } = await scenario({
      supportsCimd: true,
      tokenEndpointAuthMethods: ["private_key_jwt"],
    });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED");
    const registration = await registrationOf(gateway);
    expect(registration.tokenEndpointAuthMethod).toBe("private_key_jwt");
    // A successful exchange means the mock verified the ES256 assertion
    // against the gateway's published JWKS.
    expect(upstream.authorizationServer.stats.codeExchanges).toBe(1);
  });

  it("authenticates a confidential DCR client with client_secret_basic", async () => {
    const { gateway, upstream } = await scenario({
      supportsDcr: true,
      tokenEndpointAuthMethods: ["client_secret_basic"],
    });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED");
    expect((await registrationOf(gateway)).tokenEndpointAuthMethod).toBe(
      "client_secret_basic",
    );
  });

  it("authenticates a confidential DCR client with client_secret_post", async () => {
    const { gateway, upstream } = await scenario({
      supportsDcr: true,
      tokenEndpointAuthMethods: ["client_secret_post"],
    });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED");
    expect((await registrationOf(gateway)).tokenEndpointAuthMethod).toBe(
      "client_secret_post",
    );
  });

  it("parks the connection when no automatic mechanism is available", async () => {
    const { gateway, upstream } = await scenario({});
    const created = await gateway.createConnection(upstream.url).catch((error: Error) => error);

    // Creating the connection surfaces the terminal registration strategy as a
    // clear, provider-neutral instruction rather than a stack trace.
    expect(created).toBeInstanceOf(Error);
    expect((created as Error).message).toContain("client_credentials_required");
  });

  it("uses preconfigured credentials an operator supplied for the issuer", async () => {
    const { gateway, upstream } = await scenario({
      tokenEndpointAuthMethods: ["client_secret_basic"],
    });
    upstream.authorizationServer.preregisterClient({
      clientId: "portal-client",
      clientSecret: "portal-secret",
      tokenEndpointAuthMethod: "client_secret_basic",
      redirectUris: [`${gateway.baseUrl}/oauth/callback`],
    });

    const configured = await gateway.api("POST", "/api/v1/oauth-client-configurations", {
      issuer: upstream.authorizationServer.issuer,
      client_id: "portal-client",
      client_secret: "portal-secret",
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(configured.status).toBe(201);

    const { connection } = await connectUpstream(gateway, upstream.url);
    expect(connection.status).toBe("CONNECTED");
    const registration = await registrationOf(gateway);
    expect(registration.registrationType).toBe("PRECONFIGURED");
    expect(registration.clientId).toBe("portal-client");
  });

  it("fails registration when a restricted server demands an initial access token", async () => {
    const { gateway, upstream } = await scenario({
      supportsDcr: true,
      initialAccessToken: "operator-issued-token",
    });
    const created = await gateway.createConnection(upstream.url).catch((error: Error) => error);

    expect(created).toBeInstanceOf(Error);
    expect(upstream.authorizationServer.stats.registrations).toBe(1);
  });

  it("treats a connection without a refresh token as non-refreshable", async () => {
    const { gateway, upstream } = await scenario({
      supportsDcr: true,
      issueRefreshToken: false,
    });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED_NON_REFRESHABLE");
  });

  it("stores only the scopes the authorization server actually granted", async () => {
    const { gateway, upstream } = await scenario({
      supportsDcr: true,
      fixedScopes: ["mcp:read"],
    });
    const { connection } = await connectUpstream(gateway, upstream.url);

    const record = await connectionRecord(gateway, connection.connection_id);
    expect(record.grantedScopes).toEqual(["mcp:read"]);
  });

  it("discovers metadata published at the OpenID Connect location", async () => {
    const { gateway, upstream } = await scenario({
      supportsDcr: true,
      discoveryStyle: "openid",
    });
    const { connection } = await connectUpstream(gateway, upstream.url);

    expect(connection.status).toBe("CONNECTED");
  });
});

async function registrationOf(gateway: GatewayFixture): Promise<{
  registrationType: string;
  clientId: string;
  tokenEndpointAuthMethod: string;
}> {
  const connections = await gateway.services.store.connections.listByTenant(
    gateway.tenantId,
  );
  const connection = connections[0];
  if (!connection?.oauthClientRegistrationId) {
    throw new Error("The connection has no client registration");
  }
  const record = await gateway.services.store.registrations.get(
    connection.oauthClientRegistrationId,
  );
  if (!record) throw new Error("The client registration record is missing");
  return record;
}

async function connectionRecord(
  gateway: GatewayFixture,
  connectionId: string,
): Promise<{ grantedScopes: string[]; status: string }> {
  const record = await gateway.services.store.connections.get(
    gateway.tenantId,
    connectionId,
  );
  if (!record) throw new Error("The connection record is missing");
  return record;
}
