import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discover,
  installCommand,
  parseArgs,
  pruneCommand,
  rollbackCommand,
  type CliContext,
  type Output,
  type PathContext,
} from "@uap/migration-cli";

const GATEWAY_MCP_URL = "https://gateway.example.com/mcp";

const GITHUB = "https://mcp.github.example/mcp";
const LINEAR = "https://mcp.linear.example/sse";
const SLACK = "https://mcp.slack.example/mcp";
const NOTION = "https://mcp.notion.example/mcp";
const RUNBOOKS = "https://mcp.internal.example/mcp";

interface Sandbox {
  root: string;
  home: string;
  cwd: string;
  paths: PathContext;
  stateDir: string;
  read(relative: string): Promise<string>;
  exists(relative: string): Promise<boolean>;
}

const sandboxes: string[] = [];

afterEach(async () => {
  for (const root of sandboxes.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/** A machine with the same remote MCP server configured in several clients. */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "uap-migrate-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });

  await write(
    join(home, ".cursor", "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          github: { url: GITHUB },
          filesystem: { command: "npx", args: ["-y", "server-filesystem"] },
        },
      },
      null,
      2,
    )}\n`,
  );

  await write(
    join(home, ".claude.json"),
    `${JSON.stringify(
      {
        numStartups: 12,
        mcpServers: { linear: { type: "sse", url: LINEAR } },
        // The same GitHub server, reached with a trailing slash.
        projects: { "/work/api": { mcpServers: { github: { url: `${GITHUB}/` } } } },
      },
      null,
      2,
    )}\n`,
  );

  await write(
    join(home, ".codex", "config.toml"),
    [
      'model = "gpt-5.1-codex"',
      "",
      "# Runs on this machine.",
      "[mcp_servers.docs]",
      'command = "python"',
      'args = ["docs.py"]',
      "",
      "[mcp_servers.docs.env]",
      'DOCS_ROOT = "/srv/docs"',
      "",
      "[mcp_servers.slack]",
      `url = "${SLACK}"`,
      'bearer_token_env_var = "SLACK_TOKEN"',
      "",
    ].join("\n"),
  );

  await write(
    join(home, ".config", "Claude", "claude_desktop_config.json"),
    `${JSON.stringify({ mcpServers: { notion: { url: NOTION } } }, null, 2)}\n`,
  );

  await write(
    join(cwd, ".vscode", "mcp.json"),
    ["{", "  // Internal runbooks.", '  "servers": {', `    "runbooks": { "type": "http", "url": "${RUNBOOKS}" }`, "  }", "}", ""].join("\n"),
  );

  const paths: PathContext = { home, cwd, platform: "linux", env: {} };
  return {
    root,
    home,
    cwd,
    paths,
    stateDir: join(root, "state"),
    read: (relative) => readFile(join(root, relative), "utf8"),
    exists: async (relative) =>
      readFile(join(root, relative), "utf8").then(
        () => true,
        () => false,
      ),
  };
}

function capture(): Output & { text: string[]; values: unknown[] } {
  const text: string[] = [];
  const values: unknown[] = [];
  return {
    text,
    values,
    line: (line) => text.push(line),
    json: (value) => values.push(value),
  };
}

function contextFor(box: Sandbox, out: Output, overrides: Partial<CliContext> = {}): CliContext {
  return {
    paths: box.paths,
    out,
    stateDir: box.stateDir,
    json: false,
    allowHttp: false,
    clientIds: [],
    entryName: "universal-gateway",
    ...overrides,
  };
}

const installOptions = {
  gatewayMcpUrl: GATEWAY_MCP_URL,
  entryName: "universal-gateway",
  apiKey: "gw_secret_key",
  apiKeyEnvVar: "UAP_GATEWAY_API_KEY",
  inlineKey: false,
  dryRun: false,
};

describe("discovery", () => {
  it("finds every remote server across the installed clients", async () => {
    const box = await sandbox();
    const result = await discover(box.paths, { gatewayMcpUrl: GATEWAY_MCP_URL });

    expect(result.servers.map((server) => server.canonicalUrl).sort()).toEqual(
      [GITHUB, LINEAR, NOTION, RUNBOOKS, SLACK].sort(),
    );
    expect(result.configs.filter((config) => config.exists)).toHaveLength(5);
    expect(result.configs.every((config) => config.error === null)).toBe(true);
  });

  it("collapses the same server configured in two clients into one import", async () => {
    const box = await sandbox();
    const result = await discover(box.paths, {});

    const github = result.servers.find((server) => server.canonicalUrl === GITHUB);
    expect(github?.sources.map((source) => source.clientId).sort()).toEqual([
      "claude-code",
      "cursor",
    ]);
    // The alias follows the name the user already chose.
    expect(github?.suggestedAlias).toBe("github");
  });

  it("reports local stdio servers instead of importing them", async () => {
    const box = await sandbox();
    const result = await discover(box.paths, {});

    const stdio = result.skipped.filter((entry) => entry.reason === "stdio");
    expect(stdio.map((entry) => entry.name).sort()).toEqual(["docs", "filesystem"]);
    expect(result.servers.some((server) => server.suggestedAlias === "docs")).toBe(false);
  });

  it("never imports the gateway into itself", async () => {
    const box = await sandbox();
    await write(
      join(box.home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { "universal-gateway": { url: `${GATEWAY_MCP_URL}/` } },
      }),
    );

    const result = await discover(box.paths, { gatewayMcpUrl: GATEWAY_MCP_URL });
    expect(result.servers.some((server) => server.canonicalUrl.includes("gateway"))).toBe(
      false,
    );
    expect(result.skipped.some((entry) => entry.reason === "gateway")).toBe(true);
  });

  it("reads a file once when the project directory is the home directory", async () => {
    const box = await sandbox();
    const paths: PathContext = { ...box.paths, cwd: box.home };

    const result = await discover(paths, {});

    const cursor = result.configs.filter((config) => config.location.clientId === "cursor");
    expect(cursor).toHaveLength(1);
    const github = result.servers.find((server) => server.canonicalUrl === GITHUB);
    expect(github?.sources.filter((source) => source.clientId === "cursor")).toHaveLength(1);
  });

  it("keeps going when one configuration file is corrupt", async () => {
    const box = await sandbox();
    await write(join(box.home, ".cursor", "mcp.json"), "{ not json");

    const result = await discover(box.paths, {});
    const cursor = result.configs.find((config) => config.location.clientId === "cursor");
    expect(cursor?.error).toBeTypeOf("string");
    expect(result.servers.map((server) => server.canonicalUrl)).toContain(SLACK);
  });
});

describe("install", () => {
  it("adds the gateway to every client that can reference an environment variable", async () => {
    const box = await sandbox();
    const out = capture();
    expect(await installCommand(contextFor(box, out), installOptions)).toBe(0);

    const cursor = JSON.parse(await box.read("home/.cursor/mcp.json")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(cursor.mcpServers["universal-gateway"]).toEqual({
      type: "http",
      url: GATEWAY_MCP_URL,
      headers: { Authorization: "Bearer ${env:UAP_GATEWAY_API_KEY}" },
    });
    // The servers the user already had are untouched.
    expect(cursor.mcpServers["github"]).toEqual({ url: GITHUB });

    const claude = JSON.parse(await box.read("home/.claude.json")) as {
      mcpServers: Record<string, { headers: Record<string, string> }>;
      numStartups: number;
    };
    expect(claude.mcpServers["universal-gateway"]?.headers["Authorization"]).toBe(
      "Bearer ${UAP_GATEWAY_API_KEY}",
    );
    expect(claude.numStartups).toBe(12);

    const vscode = JSON.parse(await box.read("project/.vscode/mcp.json")) as {
      servers: Record<string, unknown>;
    };
    expect(vscode.servers["universal-gateway"]).toBeDefined();
    expect(vscode.servers["runbooks"]).toBeDefined();
  });

  it("writes Codex TOML that Codex can actually read", async () => {
    const box = await sandbox();
    await installCommand(contextFor(box, capture()), installOptions);

    const toml = await box.read("home/.codex/config.toml");
    const lines = toml.split("\n");
    const flag = lines.indexOf("experimental_use_rmcp_client = true");
    const firstTable = lines.findIndex((line) => line.startsWith("["));
    // Codex only honours the flag when it precedes every table.
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(flag).toBeLessThan(firstTable);

    expect(toml).toContain("[mcp_servers.universal-gateway]");
    expect(toml).toContain(`url = "${GATEWAY_MCP_URL}"`);
    // Codex takes the name of the variable, never the token itself.
    expect(toml).toContain('bearer_token_env_var = "UAP_GATEWAY_API_KEY"');
    expect(toml).not.toContain("gw_secret_key");

    // Everything the user wrote survives, comments included.
    expect(toml).toContain('model = "gpt-5.1-codex"');
    expect(toml).toContain("# Runs on this machine.");
    expect(toml).toContain("[mcp_servers.docs.env]");
    expect(toml).toContain('bearer_token_env_var = "SLACK_TOKEN"');
  });

  it("refuses to write the key in plain text unless asked", async () => {
    const box = await sandbox();
    const out = capture();
    await installCommand(contextFor(box, out), installOptions);

    const desktop = JSON.parse(await box.read("home/.config/Claude/claude_desktop_config.json")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(desktop.mcpServers["universal-gateway"]).toBeUndefined();
    expect(out.text.join("\n")).toContain("--inline-key");

    await installCommand(contextFor(box, capture()), { ...installOptions, inlineKey: true });
    const after = JSON.parse(await box.read("home/.config/Claude/claude_desktop_config.json")) as {
      mcpServers: Record<string, { headers: Record<string, string> }>;
    };
    expect(after.mcpServers["universal-gateway"]?.headers["Authorization"]).toBe(
      "Bearer gw_secret_key",
    );
  });

  it("is safe to run twice", async () => {
    const box = await sandbox();
    await installCommand(contextFor(box, capture()), installOptions);
    const first = await box.read("home/.codex/config.toml");

    const out = capture();
    await installCommand(contextFor(box, out), installOptions);
    expect(await box.read("home/.codex/config.toml")).toBe(first);
    expect(out.text.join("\n")).toContain("already correct");
  });

  it("changes nothing on a dry run", async () => {
    const box = await sandbox();
    const before = await box.read("home/.cursor/mcp.json");
    const out = capture();

    await installCommand(contextFor(box, out), { ...installOptions, dryRun: true });

    expect(await box.read("home/.cursor/mcp.json")).toBe(before);
    expect(out.text.join("\n")).toContain("home/.cursor/mcp.json");
  });

  it("leaves no trace of a client the user does not have", async () => {
    const box = await sandbox();
    await rm(join(box.home, ".cursor"), { recursive: true, force: true });
    const out = capture();

    await installCommand(contextFor(box, out), installOptions);

    expect(await box.exists("home/.cursor/mcp.json")).toBe(false);
    expect(out.text.join("\n")).toContain("does not appear to be installed");
    // The clients that are installed still get configured.
    expect(await box.read("home/.codex/config.toml")).toContain("universal-gateway");
  });

  it("configures a client the user names even without a trace of it", async () => {
    const box = await sandbox();
    await rm(join(box.home, ".cursor"), { recursive: true, force: true });

    await installCommand(contextFor(box, capture(), { clientIds: ["cursor"] }), {
      ...installOptions,
      clientIds: ["cursor"],
    });

    expect(await box.read("home/.cursor/mcp.json")).toContain("universal-gateway");
  });

  it("can target a single client", async () => {
    const box = await sandbox();
    await installCommand(contextFor(box, capture(), { clientIds: ["codex"] }), {
      ...installOptions,
      clientIds: ["codex"],
    });

    expect(await box.read("home/.codex/config.toml")).toContain("universal-gateway");
    expect(await box.read("home/.cursor/mcp.json")).not.toContain("universal-gateway");
  });
});

describe("prune and rollback", () => {
  const gatewayStub = (connections: { alias: string; status: string; mcp_url: string }[]) =>
    ({
      mcpUrl: GATEWAY_MCP_URL,
      connections: async () =>
        connections.map((connection, index) => ({
          connection_id: `conn_${index}`,
          alias: connection.alias,
          status: connection.status,
          mcp_url: connection.mcp_url,
          display_name: connection.alias,
          tool_count: 3,
          last_error: null,
        })),
    }) as unknown as Parameters<typeof pruneCommand>[1];

  it("removes only the servers the gateway is actually serving", async () => {
    const box = await sandbox();
    await installCommand(contextFor(box, capture()), installOptions);

    const gateway = gatewayStub([
      { alias: "github", status: "CONNECTED", mcp_url: GITHUB },
      { alias: "slack", status: "CONNECTED", mcp_url: SLACK },
      // Never authorized, so the direct entry has to stay.
      { alias: "linear", status: "AUTHORIZATION_REQUIRED", mcp_url: LINEAR },
    ]);

    expect(
      await pruneCommand(contextFor(box, capture()), gateway, { dryRun: false, yes: true }),
    ).toBe(0);

    const cursor = JSON.parse(await box.read("home/.cursor/mcp.json")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cursor.mcpServers).sort()).toEqual([
      "filesystem",
      "universal-gateway",
    ]);

    const claude = JSON.parse(await box.read("home/.claude.json")) as {
      mcpServers: Record<string, unknown>;
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    expect(claude.mcpServers["linear"]).toBeDefined();
    // The duplicate in the project map goes too.
    expect(claude.projects["/work/api"]?.mcpServers["github"]).toBeUndefined();

    const toml = await box.read("home/.codex/config.toml");
    expect(toml).not.toContain("[mcp_servers.slack]");
    expect(toml).toContain("[mcp_servers.docs]");
    expect(toml).toContain("[mcp_servers.universal-gateway]");
  });

  it("asks before removing anything", async () => {
    const box = await sandbox();
    const before = await box.read("home/.cursor/mcp.json");
    const out = capture();

    const code = await pruneCommand(
      contextFor(box, out),
      gatewayStub([{ alias: "github", status: "CONNECTED", mcp_url: GITHUB }]),
      { dryRun: false, yes: false },
    );

    expect(code).toBe(2);
    expect(await box.read("home/.cursor/mcp.json")).toBe(before);
    expect(out.text.join("\n")).toContain("--yes");
  });

  it("puts every file back the way it was", async () => {
    const box = await sandbox();
    const originals = await Promise.all(
      [
        "home/.cursor/mcp.json",
        "home/.claude.json",
        "home/.codex/config.toml",
        "project/.vscode/mcp.json",
      ].map(async (path) => [path, await box.read(path)] as const),
    );

    await installCommand(contextFor(box, capture()), installOptions);
    expect(await box.read("home/.cursor/mcp.json")).not.toBe(originals[0]?.[1]);

    expect(await rollbackCommand(contextFor(box, capture()))).toBe(0);
    for (const [path, contents] of originals) {
      expect(await box.read(path)).toBe(contents);
    }
  });

  it("deletes a file it created rather than leaving an empty one behind", async () => {
    const box = await sandbox();
    await rm(join(box.home, ".cursor", "mcp.json"), { force: true });

    await installCommand(contextFor(box, capture()), installOptions);
    expect(await box.exists("home/.cursor/mcp.json")).toBe(true);

    await rollbackCommand(contextFor(box, capture()));
    expect(await box.exists("home/.cursor/mcp.json")).toBe(false);
  });
});

describe("argument parsing", () => {
  it("reads flags in both forms and collects repeated ones", () => {
    const { command, flags } = parseArgs([
      "install",
      "--gateway=https://gw.example.com",
      "--client",
      "cursor",
      "--client",
      "codex",
      "--dry-run",
    ]);

    expect(command).toBe("install");
    expect(flags.get("gateway")).toEqual(["https://gw.example.com"]);
    expect(flags.get("client")).toEqual(["cursor", "codex"]);
    expect(flags.get("dry-run")).toEqual(["true"]);
  });
});
