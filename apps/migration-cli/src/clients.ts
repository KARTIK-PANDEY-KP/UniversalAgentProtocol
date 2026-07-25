import { join } from "node:path";

/**
 * Every supported host stores its MCP servers in one of three shapes. The
 * gateway never needs to know which application it is talking to, so the only
 * per-client knowledge kept here is where the file lives, how it is encoded
 * and whether the client can dereference an environment variable.
 */
export type ConfigFormat = "json-mcp-servers" | "json-vscode" | "toml-codex";

export type ConfigScope = "user" | "project";

export interface PathContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface ConfigLocation {
  clientId: string;
  clientLabel: string;
  format: ConfigFormat;
  scope: ConfigScope;
  path: string;
  /** Whether `install` may create this file when it does not exist yet. */
  creatable: boolean;
}

export interface ClientDefinition {
  id: string;
  label: string;
  format: ConfigFormat;
  /**
   * Renders a reference to an environment variable in the client's own
   * syntax, or null when the client only accepts literal values. Clients that
   * can dereference a variable never receive the gateway key on disk.
   */
  envReference: ((variable: string) => string) | null;
  locations(context: PathContext): ConfigLocation[];
}

function location(
  client: Pick<ClientDefinition, "id" | "label" | "format">,
  scope: ConfigScope,
  path: string,
  creatable: boolean,
): ConfigLocation {
  return {
    clientId: client.id,
    clientLabel: client.label,
    format: client.format,
    scope,
    path,
    creatable,
  };
}

const cursor: ClientDefinition = {
  id: "cursor",
  label: "Cursor",
  format: "json-mcp-servers",
  envReference: (variable) => `\${env:${variable}}`,
  locations({ home, cwd }) {
    return [
      location(cursor, "user", join(home, ".cursor", "mcp.json"), true),
      location(cursor, "project", join(cwd, ".cursor", "mcp.json"), false),
    ];
  },
};

const claudeCode: ClientDefinition = {
  id: "claude-code",
  label: "Claude Code",
  format: "json-mcp-servers",
  envReference: (variable) => `\${${variable}}`,
  locations({ home, cwd }) {
    return [
      location(claudeCode, "user", join(home, ".claude.json"), true),
      location(claudeCode, "project", join(cwd, ".mcp.json"), false),
    ];
  },
};

const claudeDesktop: ClientDefinition = {
  id: "claude-desktop",
  label: "Claude Desktop",
  format: "json-mcp-servers",
  // Claude Desktop reads the file verbatim, so a key written here is a key
  // stored in plaintext. `install` refuses to do that without --inline-key.
  envReference: null,
  locations({ home, platform, env }) {
    const file = "claude_desktop_config.json";
    if (platform === "darwin") {
      const path = join(home, "Library", "Application Support", "Claude", file);
      return [location(claudeDesktop, "user", path, false)];
    }
    if (platform === "win32") {
      const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
      return [location(claudeDesktop, "user", join(appData, "Claude", file), false)];
    }
    return [location(claudeDesktop, "user", join(home, ".config", "Claude", file), false)];
  },
};

const codex: ClientDefinition = {
  id: "codex",
  label: "Codex",
  format: "toml-codex",
  // Codex takes the *name* of the variable in bearer_token_env_var.
  envReference: (variable) => variable,
  locations({ home, cwd }) {
    return [
      location(codex, "user", join(home, ".codex", "config.toml"), true),
      location(codex, "project", join(cwd, ".codex", "config.toml"), false),
    ];
  },
};

const vscode: ClientDefinition = {
  id: "vscode",
  label: "VS Code",
  format: "json-vscode",
  envReference: (variable) => `\${env:${variable}}`,
  locations({ cwd }) {
    return [location(vscode, "project", join(cwd, ".vscode", "mcp.json"), false)];
  },
};

export const CLIENTS: ClientDefinition[] = [
  cursor,
  claudeCode,
  claudeDesktop,
  codex,
  vscode,
];

export function clientById(id: string): ClientDefinition | undefined {
  return CLIENTS.find((client) => client.id === id);
}

export function pathContext(overrides: Partial<PathContext> = {}): PathContext {
  const env = overrides.env ?? process.env;
  return {
    home: overrides.home ?? env["HOME"] ?? env["USERPROFILE"] ?? process.cwd(),
    cwd: overrides.cwd ?? process.cwd(),
    platform: overrides.platform ?? process.platform,
    env,
  };
}

/** Every candidate config path, whether or not the file exists yet. */
export function candidateLocations(
  context: PathContext,
  clientIds: string[] = [],
): ConfigLocation[] {
  const wanted = clientIds.length === 0 ? CLIENTS : CLIENTS.filter((client) => clientIds.includes(client.id));
  return wanted.flatMap((client) => client.locations(context));
}
