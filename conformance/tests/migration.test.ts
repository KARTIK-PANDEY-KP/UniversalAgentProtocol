import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayControlPlane,
  discover,
  importCommand,
  installCommand,
  pruneCommand,
  rollbackCommand,
  statusCommand,
  type CliContext,
  type Output,
  type PathContext,
} from "@umg/migration-cli";
import {
  GatewayFixture,
  GatewayMcpClient,
  completeAuthorization,
  startProtectedUpstream,
  type ProtectedUpstream,
} from "@umg/conformance";

/**
 * Section 6.2 and phase 5. The user already has two protected MCP servers
 * configured directly in Cursor and Codex. After the migration they authorize
 * each server exactly once, every client points at the gateway instead, and
 * the direct entries can be removed without the clients noticing.
 */
describe("migrating existing MCP configurations", () => {
  const started: { stop(): Promise<void> }[] = [];
  const sandboxes: string[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
    for (const root of sandboxes.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function upstream(tool: string): Promise<ProtectedUpstream> {
    const server = await startProtectedUpstream({
      authorizationServer: { supportsDcr: true },
      mcpServer: { tools: [{ name: tool }] },
    });
    started.push(server);
    return server;
  }

  async function newGateway(): Promise<GatewayFixture> {
    const gateway = new GatewayFixture();
    await gateway.start();
    started.push(gateway);
    return gateway;
  }

  async function workstation(servers: {
    cursor: Record<string, string>;
    codex: Record<string, string>;
  }): Promise<{ home: string; cwd: string; paths: PathContext; stateDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "umg-migration-"));
    sandboxes.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });

    const cursorEntries = Object.fromEntries(
      Object.entries(servers.cursor).map(([name, url]) => [name, { url }]),
    );
    await writeFileAt(
      join(home, ".cursor", "mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            ...cursorEntries,
            notes: { command: "npx", args: ["-y", "notes-mcp"] },
          },
        },
        null,
        2,
      )}\n`,
    );

    const codexLines = ['model = "gpt-5.1-codex"', ""];
    for (const [name, url] of Object.entries(servers.codex)) {
      codexLines.push(`[mcp_servers.${name}]`, `url = "${url}"`, "");
    }
    await writeFileAt(join(home, ".codex", "config.toml"), codexLines.join("\n"));

    return {
      home,
      cwd,
      paths: { home, cwd, platform: "linux", env: {} },
      stateDir: join(root, "state"),
    };
  }

  function contextFor(
    machine: { paths: PathContext; stateDir: string },
    out: Output,
  ): CliContext {
    return {
      paths: machine.paths,
      out,
      stateDir: machine.stateDir,
      json: false,
      // The mock upstreams and the gateway fixture are on http loopback.
      allowHttp: true,
      clientIds: [],
      entryName: "universal-gateway",
    };
  }

  function capture(): Output & { text: string[] } {
    const text: string[] = [];
    return { text, line: (line) => text.push(line), json: () => undefined };
  }

  /** Follows every authorization link the gateway is still waiting on. */
  async function authorizePending(
    gateway: GatewayFixture,
    control: GatewayControlPlane,
  ): Promise<number> {
    let authorized = 0;
    for (const connection of await control.connections()) {
      if (connection.status !== "AUTHORIZATION_REQUIRED") continue;
      const authorizationUrl = await control.authorize(connection.connection_id);
      const outcome = await completeAuthorization(authorizationUrl, {
        gatewayApiKey: gateway.apiKey,
        gatewayBaseUrl: gateway.baseUrl,
      });
      expect(outcome.status).toBe(200);
      authorized += 1;
    }
    return authorized;
  }

  it("imports, authorizes once, installs, and serves every client", async () => {
    const code = await upstream("search_code");
    const chat = await upstream("list_channels");
    const gateway = await newGateway();
    const control = new GatewayControlPlane(gateway.baseUrl, gateway.apiKey);

    const machine = await workstation({
      cursor: { code: code.url, chat: chat.url },
      // Codex reaches the same two servers, one of them with a trailing slash.
      codex: { code: `${code.url}/`, chat: chat.url },
    });

    const discovered = await discover(machine.paths, {
      allowHttp: true,
      gatewayMcpUrl: control.mcpUrl,
    });
    expect(discovered.servers).toHaveLength(2);
    expect(discovered.skipped.filter((entry) => entry.reason === "stdio")).toHaveLength(1);

    expect(await importCommand(contextFor(machine, capture()), control)).toBe(0);
    const imported = await control.connections();
    expect(imported.map((connection) => connection.alias).sort()).toEqual(["chat", "code"]);
    expect(imported.every((connection) => connection.status === "AUTHORIZATION_REQUIRED")).toBe(
      true,
    );

    // One browser round trip per protected server, and no more.
    expect(await authorizePending(gateway, control)).toBe(2);
    expect(code.authorizationServer.stats.codeExchanges).toBe(1);
    expect(chat.authorizationServer.stats.codeExchanges).toBe(1);

    const status = capture();
    expect(await statusCommand(contextFor(machine, status), control, { failOnPending: true })).toBe(
      0,
    );

    expect(await installCommand(contextFor(machine, capture()), {
      gatewayMcpUrl: control.mcpUrl,
      entryName: "universal-gateway",
      apiKey: gateway.apiKey,
      apiKeyEnvVar: "UMG_GATEWAY_API_KEY",
      inlineKey: true,
      dryRun: false,
    })).toBe(0);

    // Read the gateway back out of the config exactly as Cursor would, and
    // connect with it. Nothing else about the client changed.
    const cursorConfig = JSON.parse(
      await readFile(join(machine.home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
    const entry = cursorConfig.mcpServers["universal-gateway"];
    expect(entry?.url).toBe(control.mcpUrl);

    const client = new GatewayMcpClient({
      baseUrl: entry?.url.replace(/\/mcp$/u, "") ?? "",
      apiKey: (entry?.headers["Authorization"] ?? "").replace(/^Bearer /u, ""),
      clientInfo: { name: "cursor-vscode", version: "1.7.0" },
    });
    await client.initialize();
    expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
      "chat.list_channels",
      "code.search_code",
    ]);
    expect(await client.callTool("code.search_code")).toBeTypeOf("object");
    await client.close();

    // Codex points at the same gateway, so it shares the two grants.
    const toml = await readFile(join(machine.home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.universal-gateway]");
    expect(toml).toContain(`url = "${control.mcpUrl}"`);
  });

  it("re-running the import does not ask for a second authorization", async () => {
    const code = await upstream("search_code");
    const gateway = await newGateway();
    const control = new GatewayControlPlane(gateway.baseUrl, gateway.apiKey);
    const machine = await workstation({ cursor: { code: code.url }, codex: {} });

    await importCommand(contextFor(machine, capture()), control);
    expect(await authorizePending(gateway, control)).toBe(1);

    await importCommand(contextFor(machine, capture()), control);

    const connections = await control.connections();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status).toBe("CONNECTED");
    expect(code.authorizationServer.stats.codeExchanges).toBe(1);
  });

  it("removes the direct entries only once the gateway serves them", async () => {
    const code = await upstream("search_code");
    const chat = await upstream("list_channels");
    const gateway = await newGateway();
    const control = new GatewayControlPlane(gateway.baseUrl, gateway.apiKey);
    const machine = await workstation({
      cursor: { code: code.url, chat: chat.url },
      codex: { code: code.url },
    });

    await importCommand(contextFor(machine, capture()), control);
    // Only one of the two servers is authorized.
    const pending = (await control.connections()).find(
      (connection) => connection.alias === "code",
    );
    const authorizationUrl = await control.authorize(pending?.connection_id ?? "");
    await completeAuthorization(authorizationUrl, {
      gatewayApiKey: gateway.apiKey,
      gatewayBaseUrl: gateway.baseUrl,
    });

    await installCommand(contextFor(machine, capture()), {
      gatewayMcpUrl: control.mcpUrl,
      entryName: "universal-gateway",
      apiKey: gateway.apiKey,
      apiKeyEnvVar: "UMG_GATEWAY_API_KEY",
      inlineKey: true,
      dryRun: false,
    });
    expect(
      await pruneCommand(contextFor(machine, capture()), control, {
        dryRun: false,
        yes: true,
      }),
    ).toBe(0);

    const cursorConfig = JSON.parse(
      await readFile(join(machine.home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    // The authorized server is gone, the unauthorized one and the stdio
    // server keep working the way they did before.
    expect(Object.keys(cursorConfig.mcpServers).sort()).toEqual([
      "chat",
      "notes",
      "universal-gateway",
    ]);

    const toml = await readFile(join(machine.home, ".codex", "config.toml"), "utf8");
    expect(toml).not.toContain("[mcp_servers.code]");
    expect(toml).toContain("[mcp_servers.universal-gateway]");
  });

  it("rolls the whole migration back", async () => {
    const code = await upstream("search_code");
    const gateway = await newGateway();
    const control = new GatewayControlPlane(gateway.baseUrl, gateway.apiKey);
    const machine = await workstation({ cursor: { code: code.url }, codex: { code: code.url } });

    const files = [
      join(machine.home, ".cursor", "mcp.json"),
      join(machine.home, ".codex", "config.toml"),
    ];
    const before = await Promise.all(files.map((path) => readFile(path, "utf8")));

    await importCommand(contextFor(machine, capture()), control);
    await authorizePending(gateway, control);
    await installCommand(contextFor(machine, capture()), {
      gatewayMcpUrl: control.mcpUrl,
      entryName: "universal-gateway",
      apiKey: gateway.apiKey,
      apiKeyEnvVar: "UMG_GATEWAY_API_KEY",
      inlineKey: true,
      dryRun: false,
    });
    await pruneCommand(contextFor(machine, capture()), control, { dryRun: false, yes: true });

    // Two backups were taken, so two rollbacks return the machine to the start.
    await rollbackCommand(contextFor(machine, capture()));
    await rollbackCommand(contextFor(machine, capture()));

    for (const [index, path] of files.entries()) {
      expect(await readFile(path, "utf8")).toBe(before[index]);
    }
    // The gateway still holds the grant, so a later reinstall needs no browser.
    expect((await control.connections())[0]?.status).toBe("CONNECTED");
  });
});

async function writeFileAt(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
