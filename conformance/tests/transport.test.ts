import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@umg/core";
import { CATALOGUE_SESSION } from "@umg/federation";
import {
  GatewayFixture,
  GatewayMcpClient,
  MockMcpServer,
  connectUpstream,
  readSse,
  startProtectedUpstream,
} from "@umg/conformance";

/**
 * Section 19.3: both remote MCP transports, session lifecycle, streaming and
 * server-initiated traffic.
 */
describe("MCP transport", () => {
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

  it("talks to a stateful Streamable HTTP server and records what it negotiated", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: true, tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();

    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    expect(connection.status).toBe("CONNECTED");
    expect(upstream.mcpServer.sessionCount).toBeGreaterThan(0);

    const session = await gateway.services.store.upstreamSessions.find(
      connection.connection_id,
      CATALOGUE_SESSION,
    );
    expect(session?.status).toBe("ACTIVE");
    expect(session?.protocolVersion).not.toBe("unknown");
    // The upstream's own session handle is credential-like, so it stays with
    // the live client rather than being copied into the database.
    const stored = JSON.stringify(session);
    for (const id of upstream.mcpServer.sessionIds) {
      expect(stored).not.toContain(id);
    }
  });

  it("connects to a stateless server that issues no session id", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: false, tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();

    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    expect(connection.status).toBe("CONNECTED");
  });

  it("falls back to the legacy HTTP+SSE transport", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { transport: "HTTP_SSE", tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();

    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    expect(connection.status).toBe("CONNECTED");
    expect(connection.tool_count).toBe(1);

    const client = await connectedClient(gateway);
    const result = await client.callTool("up.ping");
    expect(result["content"]).toBeDefined();
    await client.close();
  });

  it("reinitializes after the upstream session expires and replays read-only calls", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        stateful: true,
        tools: [
          {
            name: "read_item",
            annotations: { readOnlyHint: true },
            handler: () => ({ content: [{ type: "text", text: "item" }] }),
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    expect(await client.callTool("up.read_item")).toMatchObject({
      content: [{ type: "text", text: "item" }],
    });

    upstream.mcpServer.expireSessions();
    const afterExpiry = await client.callTool("up.read_item");
    expect(afterExpiry).toMatchObject({ content: [{ type: "text", text: "item" }] });
    expect(upstream.mcpServer.stats.initializes).toBeGreaterThan(1);
    await client.close();
  });

  it("reinitializes when a restarted upstream calls the session a bad request", async () => {
    // The spec has a server disown a session id with 404. The reference server
    // answers 400 "Server not initialized" once it has restarted, and a
    // restart is how an upstream loses a session in practice, so reading only
    // the 404 leaves the connection wedged until the gateway itself restarts.
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        stateful: true,
        tools: [
          {
            name: "read_item",
            annotations: { readOnlyHint: true },
            handler: () => ({ content: [{ type: "text", text: "item" }] }),
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.callTool("up.read_item");
    const initializesBefore = upstream.mcpServer.stats.initializes;

    upstream.mcpServer.restart();
    expect(await client.callTool("up.read_item")).toMatchObject({
      content: [{ type: "text", text: "item" }],
    });
    expect(upstream.mcpServer.stats.initializes).toBeGreaterThan(initializesBefore);
    await client.close();
  });

  it("still reports a bad request that is not about the session", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: true, tools: [{ name: "read_item" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.callTool("up.read_item");
    const initializesBefore = upstream.mcpServer.stats.initializes;

    upstream.mcpServer.failNextRequests(1, 400);
    const failure = await client.callTool("up.read_item").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    // Reinitializing here would hide the fault and lose the session for nothing.
    expect(upstream.mcpServer.stats.initializes).toBe(initializesBefore);
    await client.close();
  });

  it("refuses to silently replay a write call across a session expiry", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        stateful: true,
        tools: [{ name: "create_item", annotations: { destructiveHint: false } }],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.callTool("up.create_item");
    upstream.mcpServer.expireSessions();

    const failure = await client.callTool("up.create_item").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("retry explicitly");
    await client.close();
  });

  it("streams progress notifications from the upstream to the downstream client", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        tools: [
          {
            name: "index",
            handler: async (_args, hooks) => {
              hooks.progress(1, 3, "reading");
              hooks.progress(2, 3, "parsing");
              hooks.progress(3, 3, "done");
              return { content: [{ type: "text", text: "indexed" }] };
            },
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    const progress: JsonObject[] = [];
    const result = await client.callTool("up.index", {}, {
      onProgress: (params) => progress.push(params),
    });

    expect(result).toMatchObject({ content: [{ type: "text", text: "indexed" }] });
    expect(progress.length).toBe(3);
    expect(progress.at(-1)).toMatchObject({ progress: 3, total: 3 });
    await client.close();
  });

  it("routes an upstream elicitation request to the client that triggered it", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        tools: [
          {
            name: "ask",
            handler: async (_args, hooks) => {
              const answer = await hooks.request("elicitation/create", {
                message: "Which branch?",
                requestedSchema: { type: "object" },
              });
              const result = "result" in answer ? answer.result : {};
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            },
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { elicitation: {} },
      onElicitation: () => ({ action: "accept", content: { branch: "main" } }),
    });
    await client.initialize();
    await client.openStream();

    const result = await client.callTool("up.ask", {}, { stream: true });
    const text = String((result["content"] as { text: string }[])[0]?.text ?? "");
    expect(text).toContain("main");
    await client.close();
  });

  it("asks a client that opened no standalone stream on its own request", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        tools: [
          {
            name: "ask",
            handler: async (_args, hooks) => {
              const answer = await hooks.request("elicitation/create", {
                message: "Which branch?",
                requestedSchema: { type: "object" },
              });
              const result = "result" in answer ? answer.result : {};
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            },
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { elicitation: {} },
      onElicitation: () => ({ action: "accept", content: { branch: "main" } }),
    });
    await client.initialize();

    // No openStream: several hosts never issue the GET at all. The elicitation
    // has to travel on the stream answering the call that provoked it, which
    // is the only stream this client has.
    const result = await client.callTool("up.ask", {}, { stream: true });
    const text = String((result["content"] as { text: string }[])[0]?.text ?? "");
    expect(text).toContain("main");
    await client.close();
  });

  it("rejects an upstream request the downstream client cannot handle", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        tools: [
          {
            name: "sample",
            handler: async (_args, hooks) => {
              const answer = await hooks.request("sampling/createMessage", {});
              return {
                content: [{ type: "text", text: JSON.stringify(answer) }],
                isError: "error" in answer,
              };
            },
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    // This client advertises no sampling capability.
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: {},
    });
    await client.initialize();
    await client.openStream();

    const result = await client.callTool("up.sample", {}, { stream: true });
    expect(result["isError"]).toBe(true);
    const text = String((result["content"] as { text: string }[])[0]?.text ?? "");
    expect(text).toContain("does not support sampling/createMessage");
    await client.close();
  });

  it("rejects a downstream request that declares an unknown protocol version", async () => {
    const gateway = await newGateway();
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();

    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        "content-type": "application/json",
        "mcp-session-id": client.session ?? "",
        "mcp-protocol-version": "1999-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Unsupported MCP-Protocol-Version");
    await client.close();
  });

  it("keeps the gateway usable when one upstream is unhealthy", async () => {
    const healthy = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ok" }] },
    });
    started.push(healthy);
    const broken = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "broken" }] },
    });
    started.push(broken);

    const gateway = await newGateway();
    await connectUpstream(gateway, healthy.url, { alias: "healthy" });
    await connectUpstream(gateway, broken.url, { alias: "broken" });

    const client = await connectedClient(gateway);
    expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
      "broken.broken",
      "healthy.ok",
    ]);

    broken.mcpServer.failNextRequests(20, 503);
    const failure = await client.callTool("broken.broken").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);

    // The healthy connection is untouched.
    expect(await client.callTool("healthy.ok")).toMatchObject({
      content: [{ type: "text", text: "ok ok" }],
    });
    await client.close();
  });

  it("reopens the upstream notification stream after it drops", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: true, tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.callTool("up.ping");
    await waitFor(() => upstream.mcpServer.stats.serverStreamOpens >= 1);
    const opensBefore = upstream.mcpServer.stats.serverStreamOpens;

    // A proxy timing out an idle connection looks exactly like this from the
    // client, and a stream that never comes back means notifications stop
    // arriving with nothing to say so.
    upstream.mcpServer.dropServerStreams();
    await waitFor(
      () => upstream.mcpServer.stats.serverStreamOpens > opensBefore,
      4_000,
    );

    // The tools the upstream adds after the drop still reach the catalogue.
    upstream.mcpServer.setTools([{ name: "ping" }, { name: "pong" }]);
    await waitFor(async () =>
      (await client.listTools()).some((tool) => tool.name === "up.pong"),
    );
    await client.close();
  });

  it("asks the upstream to resume from the last event it delivered", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: true, tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = await connectedClient(gateway);
    await client.callTool("up.ping");
    await waitFor(() => upstream.mcpServer.stats.serverStreamOpens >= 1);

    // Give the stream something to have delivered, then take it away.
    upstream.mcpServer.setTools([{ name: "ping" }, { name: "pong" }]);
    await waitFor(async () =>
      (await client.listTools()).some((tool) => tool.name === "up.pong"),
    );
    const opensBefore = upstream.mcpServer.stats.serverStreamOpens;
    upstream.mcpServer.dropServerStreams();
    await waitFor(
      () => upstream.mcpServer.stats.serverStreamOpens > opensBefore,
      4_000,
    );

    const [first] = upstream.mcpServer.stats.resumedFrom;
    const last = upstream.mcpServer.stats.resumedFrom.at(-1);
    expect(first).toBeNull();
    expect(last).toMatch(/^\d+$/u);
    await client.close();
  });

  it("opens one upstream session however many calls arrive at once", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { stateful: true, tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const initializesAfterConnect = upstream.mcpServer.stats.initializes;
    const sessionsAfterConnect = upstream.mcpServer.sessionCount;

    const client = await connectedClient(gateway);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => client.callTool("up.ping")),
    );
    expect(results).toHaveLength(12);

    // Twelve callers racing to be the first through an unopened connection
    // must not each build a session the others then abandon.
    expect(upstream.mcpServer.stats.initializes - initializesAfterConnect).toBe(1);
    expect(upstream.mcpServer.sessionCount - sessionsAfterConnect).toBe(1);
    await client.close();
  });

  it("refuses a POST body that is not a JSON-RPC message", async () => {
    const gateway = await newGateway();
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();

    // Neither request, notification nor response. Accepting it with a 202
    // would tell the client the gateway had taken on work it silently dropped.
    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        "content-type": "application/json",
        "mcp-session-id": client.session ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { id: unknown; error: { code: number } };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32600);
    await client.close();
  });

  it("puts each notification on one stream, not on every stream at once", async () => {
    const gateway = await newGateway();
    const server = new MockMcpServer({ requireAuth: false, tools: [{ name: "one" }] });
    await server.start();
    started.push(server);
    const connection = await gateway.createConnection(server.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    await client.openStream();

    // A second stream, as a client mid-reconnect has. Delivering the change
    // down both would make a client reading both act on it twice.
    const second = await openRawStream(gateway, client.session ?? "");
    started.push(second);

    server.setTools([{ name: "one" }, { name: "two" }], false);
    await gateway.api("POST", `/api/v1/connections/${connection.connection_id}/refresh`);
    await waitFor(() => second.events.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(second.events).toHaveLength(1);
    expect(
      client.notifications.filter(
        (notification) => notification.method === "notifications/tools/list_changed",
      ),
    ).toHaveLength(0);
    await client.close();
  });

  it("serves an MCP server that needs no authorization at all", async () => {
    const open = new MockMcpServer({
      requireAuth: false,
      tools: [{ name: "hello" }],
    });
    await open.start();
    started.push(open);

    const gateway = await newGateway();
    const connection = await gateway.createConnection(open.url, { alias: "open" });
    expect(connection.status).toBe("CONNECTED");
    expect(connection.tool_count).toBe(1);
  });
});

/**
 * A second event stream on an existing session, opened without the harness
 * client so a test can see exactly what each stream was sent.
 */
async function openRawStream(
  gateway: GatewayFixture,
  sessionId: string,
): Promise<{ events: JsonObject[]; stop(): Promise<void> }> {
  const controller = new AbortController();
  const response = await fetch(`${gateway.baseUrl}/mcp`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${gateway.apiKey}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    },
    signal: controller.signal,
  });
  if (!response.body) throw new Error("The gateway opened no stream");
  const events: JsonObject[] = [];
  void (async () => {
    try {
      for await (const event of readSse(response.body as ReadableStream<Uint8Array>)) {
        events.push(JSON.parse(event.data) as JsonObject);
      }
    } catch {
      // Ends when the test stops it.
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    events,
    stop: async () => {
      controller.abort();
    },
  };
}

/** Polls until the condition holds, so a test never sleeps a fixed guess. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function connectedClient(gateway: GatewayFixture): Promise<GatewayMcpClient> {
  const client = new GatewayMcpClient({
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
  });
  await client.initialize();
  return client;
}
