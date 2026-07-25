import { afterEach, describe, expect, it } from "vitest";

import { LATEST_PROTOCOL_VERSION } from "@umg/core";
import {
  GatewayFixture,
  GatewayMcpClient,
  completeAuthorization,
  connectUpstream,
  startProtectedUpstream,
  type GatewayMcpClientOptions,
  type ProtectedUpstream,
} from "@umg/conformance";

/**
 * Section 19.6. Each profile below is a plain remote MCP configuration of the
 * kind a user pastes into the application: a URL and a bearer credential. The
 * gateway has to work for all of them without any per-client code.
 */
const CLIENT_PROFILES: {
  label: string;
  options: Omit<GatewayMcpClientOptions, "baseUrl" | "apiKey">;
}[] = [
  {
    label: "Cursor",
    options: {
      clientInfo: { name: "cursor-vscode", version: "1.7.0" },
      capabilities: { roots: { listChanged: true } },
    },
  },
  {
    label: "Claude Code",
    options: {
      clientInfo: { name: "claude-code", version: "2.0.0" },
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      onElicitation: () => ({ action: "accept", content: { confirm: true } }),
      onSampling: () => ({
        role: "assistant",
        content: { type: "text", text: "sampled" },
        model: "test-model",
      }),
    },
  },
  {
    label: "Codex",
    options: {
      clientInfo: { name: "codex", version: "0.20.0" },
      capabilities: { elicitation: {} },
    },
  },
  {
    label: "a generic MCP SDK client",
    options: {
      clientInfo: { name: "mcp-sdk", version: "1.0.0" },
      capabilities: {},
      // An older host that has not adopted the newest revision.
      protocolVersion: "2025-06-18",
    },
  },
];

describe("client compatibility", () => {
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

  async function upstreamWithTool(): Promise<ProtectedUpstream> {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        stateful: true,
        tools: [
          {
            name: "search_code",
            handler: (args) => ({
              content: [{ type: "text", text: `found ${String(args["input"] ?? "")}` }],
            }),
          },
        ],
      },
    });
    started.push(upstream);
    return upstream;
  }

  for (const profile of CLIENT_PROFILES) {
    it(`serves ${profile.label} through a plain remote MCP configuration`, async () => {
      const upstream = await upstreamWithTool();
      const gateway = await newGateway();
      await connectUpstream(gateway, upstream.url, { alias: "code" });

      // Everything the user configures: the gateway URL and one credential.
      const client = new GatewayMcpClient({
        baseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        ...profile.options,
      });

      const initialize = await client.initialize();
      expect(initialize["serverInfo"]).toMatchObject({
        name: "universal-mcp-gateway",
      });
      expect(initialize["protocolVersion"]).toBe(
        profile.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
      );
      expect(client.session).toBeTypeOf("string");

      expect((await client.listTools()).map((tool) => tool.name)).toEqual([
        "code.search_code",
      ]);
      expect(await client.callTool("code.search_code", { input: "needle" })).toMatchObject(
        { content: [{ type: "text", text: "found needle" }] },
      );

      await client.close();
    });
  }

  it("serves every client from one upstream grant at the same time", async () => {
    const upstream = await upstreamWithTool();
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, {
      alias: "code",
    });

    const clients = await Promise.all(
      CLIENT_PROFILES.map(async (profile) => {
        const client = new GatewayMcpClient({
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          ...profile.options,
        });
        await client.initialize();
        return { label: profile.label, client };
      }),
    );

    const results = await Promise.all(
      clients.map(({ client }) => client.callTool("code.search_code", { input: "x" })),
    );
    expect(results).toHaveLength(CLIENT_PROFILES.length);

    // Distinct MCP transport sessions...
    const sessions = clients.map(({ client }) => client.session);
    expect(new Set(sessions).size).toBe(CLIENT_PROFILES.length);
    // ...resolving to exactly one upstream authorization.
    expect(upstream.authorizationServer.stats.codeExchanges).toBe(1);
    expect(upstream.authorizationServer.activeRefreshTokens()).toHaveLength(1);
    const token = await gateway.accessToken(connection.connection_id);
    const headers = new Set(upstream.mcpServer.stats.authorizationHeadersSeen);
    expect([...headers]).toEqual([`Bearer ${token}`]);

    for (const { client } of clients) await client.close();
  });

  it("adds a second upstream to every already-connected client", async () => {
    const first = await upstreamWithTool();
    const gateway = await newGateway();
    await connectUpstream(gateway, first.url, { alias: "code" });

    const clients = await Promise.all(
      CLIENT_PROFILES.map(async (profile) => {
        const client = new GatewayMcpClient({
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          ...profile.options,
        });
        await client.initialize();
        return client;
      }),
    );
    for (const client of clients) {
      expect(await client.listTools()).toHaveLength(1);
    }

    const second = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "list_channels" }] },
    });
    started.push(second);
    await connectUpstream(gateway, second.url, { alias: "chat" });

    // No client was reconfigured or restarted.
    for (const client of clients) {
      expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
        "chat.list_channels",
        "code.search_code",
      ]);
      await client.close();
    }
  });

  it("survives an upstream reconnection without touching client configuration", async () => {
    const upstream = await upstreamWithTool();
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, {
      alias: "code",
    });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      clientInfo: { name: "cursor-vscode", version: "1.7.0" },
    });
    await client.initialize();
    const sessionBefore = client.session;
    await client.callTool("code.search_code");

    // The user revokes the grant in the provider's own console.
    upstream.authorizationServer.revokeAllGrants();
    await gateway.expireAccessToken(connection.connection_id);
    const failure = await client
      .callTool("code.search_code")
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify((failure as { data?: unknown }).data)).toContain(
      "reconnect_url",
    );

    // The user reauthorizes once, in the browser, through the gateway.
    const authorizationUrl = await gateway.authorizeUrl(connection.connection_id);
    const outcome = await completeAuthorization(authorizationUrl, {
      gatewayApiKey: gateway.apiKey,
      gatewayBaseUrl: gateway.baseUrl,
    });
    expect(outcome.status).toBe(200);

    // The same client session keeps working: nothing was reconfigured.
    expect(client.session).toBe(sessionBefore);
    expect(await client.callTool("code.search_code")).toMatchObject({
      content: [{ type: "text", text: "found " }],
    });
    await client.close();
  });

  it("keeps one client's session unusable from another client's credential", async () => {
    const gateway = await newGateway();
    await gateway.addPrincipal({
      key: "second-user-key",
      tenantId: gateway.tenantId,
      userId: "user_second",
    });

    const owner = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await owner.initialize();

    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer second-user-key",
        "content-type": "application/json",
        "mcp-session-id": owner.session ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
    await owner.close();
  });

  it("ends a session cleanly when a client disconnects", async () => {
    const upstream = await upstreamWithTool();
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "code" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    const sessionId = client.session ?? "";
    await client.callTool("code.search_code");
    expect(gateway.services.northbound.sessionCount).toBe(1);

    await client.close();
    expect(gateway.services.northbound.sessionCount).toBe(0);
    const record = await gateway.services.store.downstreamSessions.get(sessionId);
    expect(record?.status).toBe("CLOSED");

    // A request on the closed session is rejected, not silently revived.
    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
  });
});
