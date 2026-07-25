import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@umg/core";
import { CATALOGUE_SESSION } from "@umg/federation";
import {
  GatewayFixture,
  GatewayMcpClient,
  MockMcpServer,
  connectUpstream,
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

  it("talks to a stateful Streamable HTTP server and carries the session id", async () => {
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
    expect(session?.upstreamSessionIdEncrypted).toBeTypeOf("string");
    // The upstream session id is credential-like and must be stored encrypted.
    expect(session?.upstreamSessionIdEncrypted).not.toContain("sess_");
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

async function connectedClient(gateway: GatewayFixture): Promise<GatewayMcpClient> {
  const client = new GatewayMcpClient({
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
  });
  await client.initialize();
  return client;
}
