import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayFixture,
  HttpFixture,
  MockAuthorizationServer,
  MockMcpServer,
  connectUpstream,
  json,
  startProtectedUpstream,
} from "@umg/conformance";

/**
 * Section 19.2: discovery must be driven entirely by what the resource and the
 * authorization server publish, and must refuse anything inconsistent.
 */
describe("OAuth discovery", () => {
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

  it("follows the resource_metadata parameter of the challenge", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();

    const { connection } = await connectUpstream(gateway, upstream.url);
    expect(connection.status).toBe("CONNECTED");

    const server = await serverRecord(gateway);
    expect(server.protectedResourceMetadataUrl).toBe(
      `${upstream.mcpServer.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
  });

  it("falls back to the well-known location when the challenge carries none", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }], advertiseResourceMetadata: false },
    });
    started.push(upstream);
    const gateway = await newGateway();

    const { connection } = await connectUpstream(gateway, upstream.url);
    expect(connection.status).toBe("CONNECTED");
  });

  it("selects the first authorization server when several are advertised", async () => {
    const primary = new MockAuthorizationServer({ supportsDcr: true });
    await primary.start();
    started.push(primary);
    const secondary = new MockAuthorizationServer({ supportsDcr: true });
    await secondary.start();
    started.push(secondary);

    const mcpServer = new MockMcpServer({
      requireAuth: true,
      authorizationServers: [primary.issuer, secondary.issuer],
      introspect: (token) => primary.introspect(token),
      tools: [{ name: "ping" }],
    });
    await mcpServer.start();
    started.push(mcpServer);

    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, mcpServer.url);

    expect(connection.status).toBe("CONNECTED");
    expect(primary.stats.codeExchanges).toBe(1);
    expect(secondary.stats.codeExchanges).toBe(0);
    expect((await serverRecord(gateway)).selectedAuthorizationServer).toBe(primary.issuer);
  });

  it("rejects authorization server metadata whose issuer does not match", async () => {
    const authorizationServer = new MockAuthorizationServer({
      supportsDcr: true,
      metadataOverrides: { issuer: "https://issuer.example.com" },
    });
    await authorizationServer.start();
    started.push(authorizationServer);

    const gateway = await newGateway();
    const failure = await gateway.services.discovery
      .discoverAuthorizationServer(authorizationServer.issuer)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Unable to load authorization server metadata");
    expect(gateway.services.metrics.render()).toContain("invalid_issuer_total");
  });

  it("rejects protected resource metadata that describes another resource", async () => {
    const mcpServer = new MockMcpServer({
      requireAuth: true,
      authorizationServers: ["https://issuer.example.com"],
      protectedResourceMetadataOverrides: { resource: "https://elsewhere.example.com/mcp" },
      tools: [{ name: "ping" }],
    });
    await mcpServer.start();
    started.push(mcpServer);

    const gateway = await newGateway();
    const failure = await gateway.services.discovery
      .discoverProtectedResource(mcpServer.url)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(gateway.services.metrics.render()).toContain("resource_mismatch_total");
  });

  it("rejects protected resource metadata that lists no authorization server", async () => {
    const mcpServer = new MockMcpServer({
      requireAuth: true,
      authorizationServers: [],
      tools: [{ name: "ping" }],
    });
    await mcpServer.start();
    started.push(mcpServer);

    const gateway = await newGateway();
    const failure = await gateway.services.discovery
      .discoverProtectedResource(mcpServer.url)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
  });

  it("rejects malformed and non-JSON metadata", async () => {
    const fixture = new HttpFixture((request, res) => {
      if (request.url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{ not json");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>hello</html>");
    });
    await fixture.start();
    started.push({ stop: () => fixture.stop() });

    const gateway = await newGateway();
    const failure = await gateway.services.discovery
      .discoverProtectedResource(`${fixture.baseUrl}/mcp`)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Unable to load protected resource metadata");
  });

  it("refuses a metadata response that exceeds the size limit", async () => {
    const fixture = new HttpFixture((_request, res) => {
      const filler = "x".repeat(2_000_000);
      json(res, 200, { resource: "http://example.com/mcp", filler });
    });
    await fixture.start();
    started.push({ stop: () => fixture.stop() });

    const gateway = await newGateway();
    const failure = await gateway.services.fetcher
      .getJson(`${fixture.baseUrl}/.well-known/oauth-protected-resource`)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("exceeded");
  });

  it("caches authorization server metadata until it expires", async () => {
    const authorizationServer = new MockAuthorizationServer({ supportsDcr: true });
    await authorizationServer.start();
    started.push(authorizationServer);
    const gateway = await newGateway();

    await gateway.services.discovery.discoverAuthorizationServer(authorizationServer.issuer);
    await gateway.services.discovery.discoverAuthorizationServer(authorizationServer.issuer);
    expect(authorizationServer.stats.metadataRequests).toBe(1);

    const cached = await gateway.services.store.issuers.findByIssuer(
      authorizationServer.issuer,
    );
    if (!cached) throw new Error("The issuer was not cached");
    await gateway.services.store.issuers.upsert({ ...cached, metadataExpiresAt: 0 });

    await gateway.services.discovery.discoverAuthorizationServer(authorizationServer.issuer);
    expect(authorizationServer.stats.metadataRequests).toBe(2);
  });

  it("reports a clear error for an endpoint that does not speak MCP", async () => {
    const fixture = new HttpFixture((_request, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not an mcp server</html>");
    });
    await fixture.start();
    started.push({ stop: () => fixture.stop() });

    const gateway = await newGateway();
    const failure = await gateway
      .createConnection(`${fixture.baseUrl}/mcp`)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("did not complete MCP initialization");
  });

  it("reports a clear error for an unreachable endpoint", async () => {
    const gateway = await newGateway();
    const failure = await gateway
      .createConnection("http://127.0.0.1:1/mcp")
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Unable to reach MCP server");
  });
});

async function serverRecord(gateway: GatewayFixture): Promise<{
  protectedResourceMetadataUrl: string | null;
  selectedAuthorizationServer: string | null;
  canonicalResource: string | null;
}> {
  const connections = await gateway.services.store.connections.listByTenant(
    gateway.tenantId,
  );
  const connection = connections[0];
  if (!connection) throw new Error("No connection exists");
  const server = await gateway.services.store.mcpServers.get(
    gateway.tenantId,
    connection.mcpServerId,
  );
  if (!server) throw new Error("The MCP server record is missing");
  return server;
}
