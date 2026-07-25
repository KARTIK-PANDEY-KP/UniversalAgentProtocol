import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GatewayFixture,
  GatewayMcpClient,
  connectUpstream,
  startProtectedUpstream,
  type ProtectedUpstream,
} from "@umg/conformance";

describe("end-to-end vertical slice", () => {
  let gateway: GatewayFixture;
  let upstream: ProtectedUpstream;

  beforeEach(async () => {
    upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        name: "issues",
        tools: [
          {
            name: "search",
            description: "Search the issue tracker",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            handler: (args) => ({
              content: [{ type: "text", text: `results for ${String(args["query"])}` }],
            }),
          },
        ],
      },
    });
    gateway = new GatewayFixture();
    await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
    await upstream.stop();
  });

  it("connects an upstream once and serves its tools to an MCP client", async () => {
    const created = await gateway.createConnection(upstream.url, { alias: "issues" });
    expect(created.status).toBe("AUTHORIZATION_REQUIRED");
    expect(created.authorization_url).toContain(`${upstream.authorizationServer.issuer}/authorize`);

    const authorization = new URL(created.authorization_url as string);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(upstream.url);
    expect(authorization.searchParams.get("response_type")).toBe("code");

    const { connection } = await connectUpstream(gateway, upstream.url);
    expect(connection.status).toBe("CONNECTED");
    expect(connection.tool_count).toBe(1);

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      clientInfo: { name: "conformance-cursor", version: "1.0.0" },
    });
    const initialize = await client.initialize();
    expect(initialize["serverInfo"]).toMatchObject({ name: "universal-mcp-gateway" });

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["issues.search"]);

    const result = await client.callTool("issues.search", { query: "flaky test" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "results for flaky test" }],
    });

    // The upstream saw a bearer token, and it was not the gateway's own key.
    const [presented] = upstream.mcpServer.stats.authorizationHeadersSeen;
    expect(presented).toMatch(/^Bearer at_/u);
    expect(presented).not.toContain(gateway.apiKey);

    await client.close();
  });

  it("rejects downstream clients that present no gateway credential", async () => {
    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });
});
