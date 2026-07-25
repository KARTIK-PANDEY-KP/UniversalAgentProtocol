import { afterEach, describe, expect, it } from "vitest";

import { McpMethod, type JsonObject, type RequestId } from "@uap/core";
import {
  GatewayFixture,
  GatewayMcpClient,
  connectUpstream,
  startProtectedUpstream,
} from "@uap/conformance";

/**
 * The parts of MCP that are neither a plain request nor a plain response:
 * cancelling work in flight, subscribing to a resource, and answering a
 * question the upstream server asks the client. Each has to survive being
 * proxied, which is where a gateway usually breaks them.
 */
describe("interactive MCP behaviour", () => {
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

  it("stops upstream work when the client cancels a call", async () => {
    let observedCancellation = false;
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        tools: [
          {
            name: "slow",
            handler: async (_args, hooks) => {
              hooks.progress(1, 2, "working");
              // A well-behaved server gives up rather than finishing work
              // nobody is waiting for.
              await Promise.race([hooks.cancelled, delay(5_000)]);
              observedCancellation = true;
              return { content: [{ type: "text", text: "should not be read" }] };
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
    });
    await client.initialize();

    let requestId: RequestId | null = null;
    const call = client.callTool(
      "up.slow",
      {},
      {
        // Cancelling on the first progress notification proves the call was
        // genuinely in flight and not merely queued.
        onProgress: () => {
          if (requestId !== null) void client.cancel(requestId);
        },
        onRequestId: (id) => {
          requestId = id;
        },
      },
    );

    await expect(call).rejects.toThrow();
    await waitFor(() => upstream.mcpServer.stats.cancellations.length > 0);
    expect(observedCancellation).toBe(true);
    await client.close();
  });

  it("ignores a cancellation that arrives after the answer", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "quick" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();

    let requestId: RequestId = 0;
    expect(
      await client.callTool(
        "up.quick",
        {},
        {
          onRequestId: (id) => {
            requestId = id;
          },
        },
      ),
    ).toBeDefined();

    // The race MCP explicitly tolerates: the client could not know it was
    // already too late, so this is a no-op rather than an error.
    await client.cancel(requestId);
    expect(await client.callTool("up.quick")).toBeDefined();
    await client.close();
  });

  it("forwards a resource update to the client that subscribed", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        resources: [{ uri: "file:///notes.md", name: "notes", text: "before" }],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "docs" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    await client.openStream();

    expect(
      await client.request(McpMethod.ResourcesSubscribe, {
        uri: "docs+file:///notes.md",
      }),
    ).toEqual({});
    expect(upstream.mcpServer.stats.requestsByMethod[McpMethod.ResourcesSubscribe]).toBe(1);

    upstream.mcpServer.notifyResourceUpdated("file:///notes.md");
    const update = await waitForNotification(client, McpMethod.ResourceUpdated);
    // The client only ever knows the namespaced URI, so that is what comes
    // back; an upstream URI here would be a name it cannot resolve.
    expect(update["uri"]).toBe("docs+file:///notes.md");

    expect(
      await client.request(McpMethod.ResourcesUnsubscribe, {
        uri: "docs+file:///notes.md",
      }),
    ).toEqual({});
    expect(upstream.mcpServer.stats.requestsByMethod[McpMethod.ResourcesUnsubscribe]).toBe(
      1,
    );
    await client.close();
  });

  it("carries a sampling request out to the client and the answer back", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: {
        tools: [
          {
            name: "summarize",
            handler: async (_args, hooks) => {
              const answer = await hooks.request(McpMethod.SamplingCreateMessage, {
                messages: [
                  { role: "user", content: { type: "text", text: "summarize this" } },
                ],
                maxTokens: 100,
              });
              const result = (answer as { result?: JsonObject }).result ?? {};
              const content = result["content"] as { text?: string } | undefined;
              return { content: [{ type: "text", text: content?.text ?? "no answer" }] };
            },
          },
        ],
      },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const seen: JsonObject[] = [];
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { sampling: {} },
      onSampling: (params) => {
        seen.push(params);
        return {
          role: "assistant",
          content: { type: "text", text: "a short summary" },
          model: "test-model",
        };
      },
    });
    await client.initialize();
    await client.openStream();

    const result = await client.callTool("up.summarize", {}, { stream: true });
    expect(result["isError"]).toBeUndefined();
    expect(String((result["content"] as { text: string }[])[0]?.text)).toBe(
      "a short summary",
    );
    // The upstream's own prompt reached the client unmodified.
    expect(JSON.stringify(seen[0])).toContain("summarize this");
    await client.close();
  });

  it("pushes the client's log level upstream and enforces it on the way back", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    await client.openStream();

    // The level is set before any upstream session exists, which is when real
    // clients set it: right after initialize, long before the first tool call.
    expect(await client.request(McpMethod.LoggingSetLevel, { level: "warning" })).toEqual(
      {},
    );
    expect(upstream.mcpServer.stats.logLevel).toBeNull();

    await client.callTool("up.ping");
    await waitFor(() => upstream.mcpServer.stats.logLevel === "warning");

    upstream.mcpServer.emitLog("debug", { note: "too quiet to forward" });
    upstream.mcpServer.emitLog("error", { note: "loud enough to forward" });

    const forwarded = await waitForNotification(client, McpMethod.LoggingMessage);
    expect(forwarded["level"]).toBe("error");
    // SSE preserves order, so the debug line would already be here if the
    // gateway had passed it through.
    expect(
      client.notifications.filter(
        (notification) => notification.method === McpMethod.LoggingMessage,
      ),
    ).toHaveLength(1);
    await client.close();
  });

  it("refuses a log level that is not in the protocol", async () => {
    const gateway = await newGateway();
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    await expect(
      client.request(McpMethod.LoggingSetLevel, { level: "chatty" }),
    ).rejects.toThrow(/debug/);
    await client.close();
  });

  it("tells upstream servers when the client's roots change", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { roots: { listChanged: true } },
    });
    await client.initialize();
    await client.callTool("up.ping");

    await client.notify(McpMethod.RootsListChanged, {});
    // The gateway advertises roots.listChanged to every upstream it opens, so
    // an upstream that watches for the notification has to actually get it.
    await waitFor(() =>
      upstream.mcpServer.stats.notifications.includes(McpMethod.RootsListChanged),
    );
    await client.close();
  });

  it("answers an upstream that asks the client for its roots", async () => {
    const upstream = await rootsReadingUpstream();
    started.push(upstream);
    const gateway = await newGateway();
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { roots: { listChanged: true } },
      onRoots: () => ({ roots: [{ uri: "file:///work/project", name: "project" }] }),
    });
    await client.initialize();
    await client.openStream();

    const result = await client.callTool("up.where", {}, { stream: true });
    expect(String((result["content"] as { text: string }[])[0]?.text)).toContain(
      "file:///work/project",
    );
    await client.close();
  });

  it("withholds the client's roots when the operator turned them off", async () => {
    const upstream = await rootsReadingUpstream();
    started.push(upstream);
    // Roots name directories on the user's machine, so an operator may decide
    // no upstream needs them.
    const gateway = new GatewayFixture({ config: { allowRoots: false } });
    await gateway.start();
    started.push(gateway);
    await connectUpstream(gateway, upstream.url, { alias: "up" });

    let asked = false;
    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      capabilities: { roots: { listChanged: true } },
      onRoots: () => {
        asked = true;
        return { roots: [{ uri: "file:///work/project", name: "project" }] };
      },
    });
    await client.initialize();
    await client.openStream();

    const result = await client.callTool("up.where", {}, { stream: true });
    expect(String((result["content"] as { text: string }[])[0]?.text)).toContain(
      "does not allow",
    );
    expect(asked).toBe(false);

    // Nor is the upstream told the roots moved, which would only provoke a
    // read it is not going to be allowed.
    await client.notify(McpMethod.RootsListChanged, {});
    await delay(150);
    expect(
      upstream.mcpServer.stats.notifications.includes(McpMethod.RootsListChanged),
    ).toBe(false);
    await client.close();
  });

  it("asks for reconnection when the gateway's own client secret expires", async () => {
    const upstream = await startProtectedUpstream({
      authorizationServer: {
        supportsDcr: true,
        tokenEndpointAuthMethods: ["client_secret_basic"],
      },
      mcpServer: { tools: [{ name: "ping" }] },
    });
    started.push(upstream);
    const gateway = await newGateway();
    const { connection } = await connectUpstream(gateway, upstream.url, { alias: "up" });
    expect(connection.status).toBe("CONNECTED");

    // The grant is untouched; it is the gateway's registration that has aged
    // out, which the authorization server signals as invalid_client.
    upstream.authorizationServer.expireClientSecrets();
    await gateway.expireAccessToken(connection.connection_id);

    const client = new GatewayMcpClient({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
    });
    await client.initialize();
    await expect(client.callTool("up.ping")).rejects.toThrow();

    const record = await gateway.services.store.connections.get(
      gateway.tenantId,
      connection.connection_id,
    );
    expect(record?.status).toBe("REAUTH_REQUIRED");
    expect(record?.lastErrorCode).toBe("invalid_client");

    // The stale registration is marked so it is never presented again.
    const registration = await gateway.services.store.registrations.get(
      record?.oauthClientRegistrationId ?? "",
    );
    expect(registration?.status).toBe("INVALID");

    // The user-facing repair is one browser round trip, not an operator task.
    const view = await gateway.getConnection(connection.connection_id);
    expect(view.connect_url).toContain(connection.connection_id);
    await client.close();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for a condition");
}

/** An upstream whose only tool reports back whatever roots it was given. */
async function rootsReadingUpstream(): Promise<
  Awaited<ReturnType<typeof startProtectedUpstream>>
> {
  return startProtectedUpstream({
    authorizationServer: { supportsDcr: true },
    mcpServer: {
      tools: [
        {
          name: "where",
          handler: async (_args, hooks) => {
            const answer = await hooks.request(McpMethod.RootsList, {});
            const text =
              "result" in answer
                ? JSON.stringify(answer.result)
                : JSON.stringify(answer.error);
            return { content: [{ type: "text", text }] };
          },
        },
      ],
    },
  });
}

async function waitForNotification(
  client: GatewayMcpClient,
  method: string,
): Promise<JsonObject> {
  let found: JsonObject | undefined;
  await waitFor(() => {
    const match = client.notifications.find(
      (notification) => notification.method === method,
    );
    if (!match) return false;
    found = (match.params ?? {}) as JsonObject;
    return true;
  });
  return found ?? {};
}
