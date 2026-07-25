import { afterEach, describe, expect, it } from "vitest";

import { JsonRpcErrorCode, McpMethod, type JsonObject } from "@umg/core";
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

    // Changed quietly, so the refresh below is what discovers the difference
    // and the diff it reports is the diff being asserted on.
    server.setTools(
      [
        { name: "stable" },
        {
          name: "reshaped",
          inputSchema: { type: "object", properties: { b: { type: "number" } } },
        },
        { name: "fresh" },
      ],
      false,
    );

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

  it("separates a bad argument from a refusal in the code it answers with", async () => {
    // The protocol treats these differently and so must the gateway: a client
    // retries an argument it can fix, and gives up on a call policy will never
    // allow. Reporting both as one code leaves it unable to tell them apart.
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [
        {
          name: "count",
          inputSchema: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        { name: "delete_everything" },
      ],
    });
    await gateway.createConnection(server.url, { alias: "up" });

    const { body } = await gateway.api("GET", "/api/v1/tools");
    const tools = body["tools"] as { id: string; name: string }[];
    const blocked = tools.find((tool) => tool.name === "up.delete_everything");
    await gateway.api("POST", `/api/v1/tools/${blocked?.id}`, { enabled: false });

    const client = await connectedClient(gateway);
    await expect(client.callTool("up.count", { n: "not a number" })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    await expect(client.callTool("up.delete_everything")).rejects.toMatchObject({
      code: JsonRpcErrorCode.PolicyDenied,
    });
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

  it("rediscovers a catalogue the upstream says has changed", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "one" }] });
    await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.openStream();

    // Announced, not refreshed. Forwarding the announcement alone would send
    // the client back for a list the gateway had not itself re-read.
    server.setTools([{ name: "one" }, { name: "two" }]);
    await waitFor(async () =>
      (await client.listTools()).some((tool) => tool.name === "up.two"),
    );
    await waitFor(() => countOf(client, McpMethod.ToolListChanged) >= 1);
    await client.close();
  });

  it("announces resource and prompt changes, not just tool changes", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [{ name: "one" }],
      resources: [{ uri: "file:///a.txt", name: "a" }],
      prompts: [{ name: "greet" }],
    });
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.openStream();

    // The upstream changes quietly and the tool catalogue is untouched, so the
    // gateway has to notice the difference itself when it resyncs.
    server.setResources(
      [
        { uri: "file:///a.txt", name: "a" },
        { uri: "file:///b.txt", name: "b" },
      ],
      false,
    );
    server.setPrompts([{ name: "greet" }, { name: "farewell" }], false);
    await gateway.api("POST", `/api/v1/connections/${connection.connection_id}/refresh`);

    await waitFor(() =>
      [McpMethod.ResourceListChanged, McpMethod.PromptListChanged].every((method) =>
        client.notifications.some((notification) => notification.method === method),
      ),
    );
    expect(
      client.notifications.some(
        (notification) => notification.method === McpMethod.ToolListChanged,
      ),
    ).toBe(false);
    await client.close();
  });

  it("replays what a client missed while its event stream was down", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "one" }] });
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.openStream();

    server.setTools([{ name: "one" }, { name: "two" }], false);
    await gateway.api("POST", `/api/v1/connections/${connection.connection_id}/refresh`);
    await waitFor(() => countOf(client, McpMethod.ToolListChanged) === 1);

    // The stream drops while the session stays alive, which is what a laptop
    // sleeping or a proxy timing out looks like from here.
    await client.closeStream();
    server.setTools([{ name: "one" }], false);
    await gateway.api("POST", `/api/v1/connections/${connection.connection_id}/refresh`);

    await client.openStream({ resume: true });
    // Resuming delivers the change that happened in the gap, and does not
    // re-deliver the one the client already acknowledged by its event id.
    await waitFor(() => countOf(client, McpMethod.ToolListChanged) === 2);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["up.one"]);

    // A client that reconnects from an earlier point gets the whole window
    // again, which is the part a mere backlog of undelivered messages could
    // not do.
    await client.closeStream();
    await client.openStream({ resumeFrom: "0" });
    await waitFor(() => countOf(client, McpMethod.ToolListChanged) === 4);
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

  it("takes a whole connection out of service and puts it back", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({
      tools: [{ name: "run" }],
      resources: [{ uri: "file:///a.txt", name: "a" }],
      prompts: [{ name: "greet" }],
    });
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const disabled = await gateway.api(
      "POST",
      `/api/v1/connections/${connection.connection_id}/enabled`,
      { enabled: false },
    );
    expect(disabled.body["status"]).toBe("DISABLED");

    // Disabling has to reach every surface, not only the tool list: a resource
    // or a prompt still being served would keep the upstream reachable.
    const client = await connectedClient(gateway);
    expect(await client.listTools()).toEqual([]);
    expect(await client.listResources()).toEqual([]);
    expect(await client.listPrompts()).toEqual([]);
    await expect(client.callTool("up.run")).rejects.toThrow();
    await expect(client.readResource("up+file:///a.txt")).rejects.toThrow();
    await expect(client.getPrompt("up/greet")).rejects.toThrow();

    const enabled = await gateway.api(
      "POST",
      `/api/v1/connections/${connection.connection_id}/enabled`,
      { enabled: true },
    );
    expect(enabled.body["status"]).toBe("CONNECTED");
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["up.run"]);
    await client.close();
  });

  it("serves the rest of a catalogue an upstream listed twice", async () => {
    const gateway = await newGateway();
    // A server repeating an entry is broken, but the gateway keeps one row per
    // upstream name: passing the repeat through would fail the whole sync and
    // leave the connection with nothing at all.
    const server = await openMcpServer({
      tools: [{ name: "twin" }, { name: "twin" }, { name: "other" }],
      resources: [
        { uri: "file:///a.txt", name: "a" },
        { uri: "file:///a.txt", name: "a again" },
      ],
      prompts: [{ name: "greet" }, { name: "greet" }],
    });
    const connection = await gateway.createConnection(server.url, { alias: "up" });
    expect(connection.status).toBe("CONNECTED");

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
      "up.other",
      "up.twin",
    ]);
    expect(await client.listResources()).toHaveLength(1);
    expect(await client.listPrompts()).toHaveLength(1);
    await client.close();
  });

  it("says so when asked to toggle a tool that does not exist", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "keep" }] });
    await gateway.createConnection(server.url, { alias: "up" });

    // An UPDATE that matches no row is not a successful policy change, and
    // reporting it as one lets a typo look like a working automation.
    const response = await gateway.api("POST", "/api/v1/tools/tool_nonexistent", {
      enabled: false,
    });
    expect(response.status).toBe(404);
  });

  it("tells a client that batched initialize with other work", async () => {
    const gateway = await newGateway();
    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ]),
    });

    // Answering only the initialize would drop the second request without
    // the client ever learning it was ignored.
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("must be sent on its own");
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

  it("blocks a whole risk class when the operator configured one", async () => {
    const gateway = await newGateway({
      config: { blockedRiskLevels: ["EXTERNAL_COMMUNICATION"] },
    });
    const server = await openMcpServer({
      tools: [{ name: "read_file" }, { name: "send_email" }],
    });
    await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["up.read_file"]);
    await expect(client.callTool("up.send_email")).rejects.toThrow(/disabled by policy/u);

    const { body } = await gateway.api("GET", "/api/v1/tools");
    const blocked = (body["tools"] as { name: string; risk_level: string }[]).find(
      (tool) => tool.name === "up.send_email",
    );
    expect(blocked?.risk_level).toBe("EXTERNAL_COMMUNICATION");
    await client.close();
  });

  it("exposes unreviewed destructive tools when the operator opts in", async () => {
    const gateway = await newGateway({
      config: { exposeUnreviewedDestructive: true, confirmationRiskLevels: [] },
    });
    const server = await openMcpServer({ tools: [{ name: "delete_repository" }] });
    await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "up.delete_repository",
    ]);
    expect(await client.callTool("up.delete_repository")).toBeDefined();
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

  it("completes a prompt argument against the server that owns the prompt", async () => {
    const gateway = await newGateway();
    const seen: JsonObject[] = [];
    const docs = await openMcpServer({
      prompts: [{ name: "review", arguments: [{ name: "language" }] }],
      complete: (ref, argument) => {
        seen.push(ref);
        return ["python", "typescript"].filter((value) =>
          value.startsWith(String(argument["value"] ?? "")),
        );
      },
    });
    // A second upstream with the same prompt name, and no completions at all,
    // so routing by the namespaced reference is what makes this work.
    const wiki = await openMcpServer({ prompts: [{ name: "review" }] });
    await gateway.createConnection(docs.url, { alias: "docs" });
    await gateway.createConnection(wiki.url, { alias: "wiki" });

    const client = await connectedClient(gateway);
    const result = await client.request(McpMethod.CompletionComplete, {
      ref: { type: "ref/prompt", name: "docs/review" },
      argument: { name: "language", value: "ty" },
    });
    expect((result["completion"] as { values: string[] }).values).toEqual(["typescript"]);
    // The upstream is asked about its own prompt, not the gateway's name for it.
    expect(seen[0]).toEqual({ type: "ref/prompt", name: "review" });

    // The other upstream owns a prompt of the same name but offers no
    // completions; an empty set beats failing the client's keystroke.
    const empty = await client.request(McpMethod.CompletionComplete, {
      ref: { type: "ref/prompt", name: "wiki/review" },
      argument: { name: "language", value: "ty" },
    });
    expect(empty["completion"]).toEqual({ values: [], total: 0, hasMore: false });

    await expect(
      client.request(McpMethod.CompletionComplete, {
        ref: { type: "ref/prompt", name: "nobody/review" },
        argument: { name: "language", value: "" },
      }),
    ).rejects.toThrow(/Unknown prompt/);
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

  it("lets a read-only member list a write tool but not call it", async () => {
    // A workspace where only maintainers may change anything.
    const gateway = await newGateway({
      role: "maintainer",
      config: { writeRoles: ["maintainer"] },
    });
    await gateway.addPrincipal({
      key: "reader-key",
      tenantId: gateway.tenantId,
      userId: "user_reader",
      role: "reader",
    });
    const server = await openMcpServer({
      tools: [{ name: "read_file" }, { name: "write_file" }],
    });
    await gateway.createConnection(server.url, { alias: "up", owner_type: "WORKSPACE" });

    const reader = new GatewayMcpClient({ baseUrl: gateway.baseUrl, apiKey: "reader-key" });
    await reader.initialize();
    expect((await reader.listTools()).map((tool) => tool.name).sort()).toEqual([
      "up.read_file",
      "up.write_file",
    ]);
    expect(await reader.callTool("up.read_file")).toBeDefined();
    await expect(reader.callTool("up.write_file")).rejects.toThrow(/read-only tools/u);
    await reader.close();

    // The same call from a maintainer goes through.
    const maintainer = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await maintainer.initialize();
    expect(await maintainer.callTool("up.write_file")).toBeDefined();
    await maintainer.close();
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

  it("hands out a big catalogue one page at a time", async () => {
    const gateway = await newGateway({ config: { pageSize: 3 } });
    const server = await openMcpServer({
      tools: Array.from({ length: 7 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
      })),
      resources: Array.from({ length: 4 }, (_, index) => ({
        uri: `file:///doc-${index}.md`,
        name: `doc-${index}`,
        text: "body",
      })),
      prompts: Array.from({ length: 4 }, (_, index) => ({
        name: `prompt_${index}`,
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      })),
    });
    await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    const first = await client.request(McpMethod.ToolsList, {});
    expect(first["tools"]).toHaveLength(3);
    expect(typeof first["nextCursor"]).toBe("string");

    const second = await client.request(McpMethod.ToolsList, {
      cursor: first["nextCursor"] as string,
    });
    expect(second["tools"]).toHaveLength(3);

    const third = await client.request(McpMethod.ToolsList, {
      cursor: second["nextCursor"] as string,
    });
    expect(third["tools"]).toHaveLength(1);
    // The last page says so by leaving the cursor out entirely.
    expect(third["nextCursor"]).toBeUndefined();

    // Following the cursors yields every tool exactly once, in order.
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(
      Array.from({ length: 7 }, (_, index) => `up.tool_${String(index).padStart(2, "0")}`),
    );
    expect(await client.listResources()).toHaveLength(4);
    expect(await client.listPrompts()).toHaveLength(4);
    await client.close();
  });

  it("refuses a cursor it never issued", async () => {
    const gateway = await newGateway();
    const server = await openMcpServer({ tools: [{ name: "ping" }] });
    await gateway.createConnection(server.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await expect(
      client.request(McpMethod.ToolsList, { cursor: "not a cursor!!" }),
    ).rejects.toThrow(/cursor/u);
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

function countOf(client: GatewayMcpClient, method: string): number {
  return client.notifications.filter(
    (notification) => notification.method === method,
  ).length;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected condition");
}
