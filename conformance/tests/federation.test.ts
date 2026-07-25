import { afterEach, describe, expect, it } from "vitest";

import { McpMethod } from "@umg/core";
import {
  GatewayFixture,
  GatewayMcpClient,
  MockMcpServer,
  connectUpstream,
  startProtectedUpstream,
} from "@umg/conformance";

/**
 * Section 19.5: several unrelated upstream servers behind one gateway URL,
 * namespaced without any knowledge of what sits behind them.
 */
describe("tool federation", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function newGateway(
    options: ConstructorParameters<typeof GatewayFixture>[0] = {},
  ): Promise<GatewayFixture> {
    const gateway = new GatewayFixture(options);
    await gateway.start();
    started.push(gateway);
    return gateway;
  }

  async function openMcpServer(
    options: ConstructorParameters<typeof MockMcpServer>[0],
  ): Promise<MockMcpServer> {
    const server = new MockMcpServer({ requireAuth: false, ...options });
    await server.start();
    started.push(server);
    return server;
  }

  async function connectedClient(gateway: GatewayFixture): Promise<GatewayMcpClient> {
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    return client;
  }

  it("aggregates tools from three unrelated MCP servers", async () => {
    const gateway = await newGateway();
    const servers = await Promise.all([
      openMcpServer({ tools: [{ name: "search_code" }, { name: "create_issue" }] }),
      openMcpServer({ tools: [{ name: "search_messages" }] }),
      openMcpServer({ tools: [{ name: "list_issues" }] }),
    ]);
    const aliases = ["github", "slack", "linear"];
    for (const [index, server] of servers.entries()) {
      await gateway.createConnection(server.url, { alias: aliases[index] });
    }

    const client = await connectedClient(gateway);
    const names = (await client.listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "github.create_issue",
      "github.search_code",
      "linear.list_issues",
      "slack.search_messages",
    ]);

    // Each call reaches the server that actually owns the tool.
    await client.callTool("slack.search_messages");
    expect(servers[1]!.stats.toolCalls).toBe(1);
    expect(servers[0]!.stats.toolCalls).toBe(0);
    expect(servers[2]!.stats.toolCalls).toBe(0);
    await client.close();
  });

  it("keeps identically named tools from two servers apart", async () => {
    const gateway = await newGateway();
    const first = await openMcpServer({
      tools: [{ name: "search", handler: () => ({ content: [{ type: "text", text: "first" }] }) }],
    });
    const second = await openMcpServer({
      tools: [{ name: "search", handler: () => ({ content: [{ type: "text", text: "second" }] }) }],
    });
    await gateway.createConnection(first.url, { alias: "one" });
    await gateway.createConnection(second.url, { alias: "two" });

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
      "one.search",
      "two.search",
    ]);
    expect(await client.callTool("one.search")).toMatchObject({
      content: [{ type: "text", text: "first" }],
    });
    expect(await client.callTool("two.search")).toMatchObject({
      content: [{ type: "text", text: "second" }],
    });
    await client.close();
  });

  it("derives a distinct alias when two servers want the same default", async () => {
    const gateway = await newGateway();
    const first = await openMcpServer({ tools: [{ name: "a" }] });
    const second = await openMcpServer({ tools: [{ name: "b" }] });

    // Both are on 127.0.0.1, so the default alias derivation collides.
    const one = await gateway.createConnection(first.url);
    const two = await gateway.createConnection(second.url);
    expect(one.alias).not.toBe(two.alias);
    expect(two.alias.startsWith(one.alias)).toBe(true);
  });

  it("renames an alias and renamespaces the catalogue", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "ping" }] });
    const connection = await gateway.createConnection(server.url, { alias: "before" });

    const client = await connectedClient(gateway);
    expect((await client.listTools())[0]?.name).toBe("before.ping");

    const { status } = await gateway.api(
      "POST",
      `/api/v1/connections/${connection.connection_id}/alias`,
      { alias: "after" },
    );
    expect(status).toBe(200);

    expect((await client.listTools())[0]?.name).toBe("after.ping");
    expect(await client.callTool("after.ping")).toMatchObject({
      content: [{ type: "text", text: "ping ok" }],
    });
    // The old name is gone rather than silently aliased.
    await expect(client.callTool("before.ping")).rejects.toThrow(/Unknown tool/u);
    await client.close();
  });

  it("detects added, removed and re-shaped upstream tools", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [
        { name: "stable" },
        { name: "doomed" },
        { name: "reshaped", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
      ],
    });
    const connection = await gateway.createConnection(server.url, { alias: "up" });
    expect(connection.tool_count).toBe(3);

    server.setTools([
      { name: "stable" },
      { name: "reshaped", inputSchema: { type: "object", properties: { b: { type: "number" } } } },
      { name: "fresh" },
    ]);

    const { body } = await gateway.api(
      "POST",
      `/api/v1/connections/${connection.connection_id}/refresh`,
    );
    expect(body["added"]).toEqual(["up.fresh"]);
    expect(body["removed"]).toEqual(["up.doomed"]);
    expect(body["changed"]).toEqual(["up.reshaped"]);

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
      "up.fresh",
      "up.reshaped",
      "up.stable",
    ]);
    // The new schema is enforced, so an argument shaped for the old one fails.
    await expect(client.callTool("up.reshaped", { b: "text" })).rejects.toThrow(
      /schema/u,
    );
    await client.close();
  });

  it("tells connected clients when the catalogue changes", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "one" }] });
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.openStream();

    server.setTools([{ name: "one" }, { name: "two" }]);
    await gateway.api("POST", `/api/v1/connections/${connection.connection_id}/refresh`);
    await waitFor(() =>
      client.notifications.some(
        (notification) => notification.method === McpMethod.ToolListChanged,
      ),
    );
    await client.close();
  });

  it("hides a disabled tool and refuses to call it", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [{ name: "keep" }, { name: "hide" }],
    });
    await gateway.createConnection(server.url, { alias: "up" });

    const { body } = await gateway.api("GET", "/api/v1/tools");
    const tools = body["tools"] as { id: string; name: string }[];
    const target = tools.find((tool) => tool.name === "up.hide");
    await gateway.api("POST", `/api/v1/tools/${target?.id}`, { enabled: false });

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["up.keep"]);
    await expect(client.callTool("up.hide")).rejects.toThrow(/disabled by policy/u);
    await client.close();
  });

  it("withholds an unreviewed destructive tool by default", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [
        { name: "read_file" },
        // No annotations, so the gateway cannot know it is safe.
        { name: "delete_repository" },
      ],
    });
    await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["up.read_file"]);

    const { body } = await gateway.api("GET", "/api/v1/tools");
    const risky = (body["tools"] as { name: string; risk_level: string }[]).find(
      (tool) => tool.name === "up.delete_repository",
    );
    expect(risky?.risk_level).toBe("DESTRUCTIVE");
    await client.close();
  });

  it("asks for confirmation before running a destructive tool", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [
        {
          name: "delete_branch",
          annotations: { destructiveHint: true },
          handler: () => ({ content: [{ type: "text", text: "deleted" }] }),
        },
      ],
    });
    await gateway.createConnection(server.url, { alias: "up" });

    const approving = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { elicitation: {} },
      onElicitation: () => ({ action: "accept", content: { confirm: true } }),
    });
    await approving.initialize();
    await approving.openStream();
    expect(await approving.callTool("up.delete_branch", {}, { stream: true })).toMatchObject(
      { content: [{ type: "text", text: "deleted" }] },
    );
    await approving.close();

    // A client that cannot be asked is refused rather than run silently.
    const silent = await connectedClient(gateway);
    await expect(silent.callTool("up.delete_branch")).rejects.toThrow(/needs confirmation/u);
    await silent.close();
  });

  it("federates resources and prompts under the same alias", async () => {
    const gateway = await newGateway();
    const docs = await openMcpServer({
      resources: [
        { uri: "file:///readme.md", name: "readme", text: "docs readme" },
      ],
      prompts: [
        {
          name: "review",
          description: "Review a change",
          messages: [{ role: "user", content: { type: "text", text: "review it" } }],
        },
      ],
    });
    const wiki = await openMcpServer({
      resources: [{ uri: "file:///readme.md", name: "readme", text: "wiki readme" }],
    });
    await gateway.createConnection(docs.url, { alias: "docs" });
    await gateway.createConnection(wiki.url, { alias: "wiki" });

    const client = await connectedClient(gateway);
    const uris = (await client.listResources()).map((resource) => resource["uri"]).sort();
    expect(uris).toEqual(["docs+file:///readme.md", "wiki+file:///readme.md"]);

    // Identical upstream URIs resolve to different servers.
    expect(JSON.stringify(await client.readResource("docs+file:///readme.md"))).toContain(
      "docs readme",
    );
    expect(JSON.stringify(await client.readResource("wiki+file:///readme.md"))).toContain(
      "wiki readme",
    );

    expect((await client.listPrompts()).map((prompt) => prompt["name"])).toEqual([
      "docs/review",
    ]);
    expect(JSON.stringify(await client.getPrompt("docs/review"))).toContain("review it");
    await client.close();
  });

  it("gives each downstream client its own upstream session over one grant", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: true, tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });

    const clients = await Promise.all(
      ["cursor", "codex"].map(async (name) => {
        const client = new GatewayMcpClient({
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          clientInfo: { name, version: "1.0.0" },
        });
        await client.initialize();
        await client.callTool("up.ping");
        return client;
      }),
    );

    const sessions = await Promise.all(
      clients.map((client) =>
        gateway.services.store.upstreamSessions.find(
          connection.connection_id,
          client.session ?? "",
        ),
      ),
    );
    expect(sessions.every((session) => session !== null)).toBe(true);
    expect(new Set(sessions.map((session) => session?.id)).size).toBe(2);
    // One grant, one refresh token, several upstream transport sessions.
    expect(upstream.authorizationServer.activeRefreshTokens()).toHaveLength(1);

    for (const client of clients) await client.close();
  });

  it("shares a workspace connection with other members but keeps personal ones private", async () => {
    const gateway = await newGateway();
    await gateway.addPrincipal({
      key: "colleague-key",
      tenantId: gateway.tenantId,
      userId: "user_colleague",
    });
    const shared = await openMcpServer({ tools: [{ name: "shared_tool" }] });
    const personal = await openMcpServer({ tools: [{ name: "personal_tool" }] });
    await gateway.createConnection(shared.url, {
      alias: "shared",
      owner_type: "WORKSPACE",
    });
    await gateway.createConnection(personal.url, { alias: "personal" });

    const colleague = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: "colleague-key",
    });
    await colleague.initialize();
    expect((await colleague.listTools()).map((tool) => tool.name)).toEqual([
      "shared.shared_tool",
    ]);
    await expect(colleague.callTool("personal.personal_tool")).rejects.toThrow(
      /not available to you/u,
    );
    await colleague.close();
  });

  it("blocks a client in another tenant from reaching a connection", async () => {
    const gateway = await newGateway();
    await gateway.addPrincipal({
      key: "other-tenant-key",
      tenantId: "tenant_other",
      userId: "user_other",
    });
    const server = await openMcpServer({ tools: [{ name: "secret" }] });
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const intruder = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: "other-tenant-key",
    });
    await intruder.initialize();
    expect(await intruder.listTools()).toEqual([]);
    await expect(intruder.callTool("up.secret")).rejects.toThrow(/Unknown tool/u);
    await intruder.close();

    const { status } = await gateway.api(
      "GET",
      `/api/v1/connections/${connection.connection_id}`,
      undefined,
      "other-tenant-key",
    );
    expect(status).toBe(404);
  });

  it("removes a connection's catalogue when it is disconnected", async () => {
    const gateway = await newGateway();
    const kept = await openMcpServer({ tools: [{ name: "list_kept" }] });
    const going = await openMcpServer({ tools: [{ name: "list_going" }] });
    await gateway.createConnection(kept.url, { alias: "kept" });
    const removable = await gateway.createConnection(going.url, { alias: "going" });

    const client = await connectedClient(gateway);
    expect(await client.listTools()).toHaveLength(2);

    await gateway.api("DELETE", `/api/v1/connections/${removable.connection_id}`);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "kept.list_kept",
    ]);
    await client.close();
  });

  it("does not create a second connection for the same MCP url", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "ping" }] });
    const first = await gateway.createConnection(server.url, { alias: "up" });
    // The same endpoint written with a redundant default port and a fragment.
    const second = await gateway.createConnection(`${server.url}#fragment`, {
      alias: "duplicate",
    });
    expect(second.connection_id).toBe(first.connection_id);
    expect(await gateway.listConnections()).toHaveLength(1);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected condition");
}
