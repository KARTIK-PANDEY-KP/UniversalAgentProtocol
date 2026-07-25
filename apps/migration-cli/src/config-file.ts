import type { ConfigFormat } from "./clients.js";

export interface RemoteServerEntry {
  name: string;
  url: string;
  /** Where the entry lives inside the document, so it can be removed later. */
  container: string[];
  transport: string | null;
}

export interface LocalServerEntry {
  name: string;
  container: string[];
  command: string;
}

export interface ServerInventory {
  remote: RemoteServerEntry[];
  local: LocalServerEntry[];
}

export interface GatewayEntrySpec {
  name: string;
  url: string;
  /** Complete Authorization header, for clients that accept raw headers. */
  authorization: string;
  /** Variable name, for clients that accept only an indirection. */
  bearerTokenEnvVar: string | null;
  /** Literal key, written only when the client cannot read a variable. */
  bearerToken: string | null;
}

export interface ServerRef {
  name: string;
  container: string[];
}

export interface ConfigDocument {
  readonly path: string;
  readonly format: ConfigFormat;
  servers(): ServerInventory;
  upsertGateway(spec: GatewayEntrySpec): void;
  removeServer(ref: ServerRef): void;
  serialize(): string;
}

export function parseConfigDocument(
  path: string,
  format: ConfigFormat,
  raw: string,
): ConfigDocument {
  switch (format) {
    case "json-mcp-servers":
      return new JsonConfigDocument(path, format, raw, "mcpServers");
    case "json-vscode":
      return new JsonConfigDocument(path, format, raw, "servers");
    case "toml-codex":
      return new CodexConfigDocument(path, raw);
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

/**
 * Cursor, Claude Code, Claude Desktop and VS Code all keep a map of named
 * servers in JSON; only the key of that map differs. Claude Code additionally
 * keeps per-project maps, which are scanned but never installed into.
 */
class JsonConfigDocument implements ConfigDocument {
  private readonly document: Record<string, unknown>;
  private readonly indent: string;

  constructor(
    readonly path: string,
    readonly format: ConfigFormat,
    raw: string,
    private readonly rootKey: string,
  ) {
    this.document = raw.trim() === "" ? {} : (JSON.parse(stripJsonComments(raw)) as Record<string, unknown>);
    this.indent = detectIndent(raw);
  }

  servers(): ServerInventory {
    const inventory: ServerInventory = { remote: [], local: [] };
    for (const container of this.containers()) {
      const map = this.resolve(container);
      if (!map) continue;
      for (const [name, value] of Object.entries(map)) {
        if (!isRecord(value)) continue;
        const url = firstString(value["url"], value["serverUrl"]);
        if (url) {
          inventory.remote.push({
            name,
            url,
            container,
            transport: typeof value["type"] === "string" ? value["type"] : null,
          });
        } else if (typeof value["command"] === "string") {
          inventory.local.push({ name, container, command: value["command"] });
        }
      }
    }
    return inventory;
  }

  upsertGateway(spec: GatewayEntrySpec): void {
    const map = this.resolve([this.rootKey]) ?? {};
    map[spec.name] = {
      type: "http",
      url: spec.url,
      headers: { Authorization: spec.authorization },
    };
    this.document[this.rootKey] = map;
  }

  removeServer(ref: ServerRef): void {
    const map = this.resolve(ref.container);
    if (map) delete map[ref.name];
  }

  serialize(): string {
    return `${JSON.stringify(this.document, null, this.indent)}\n`;
  }

  /** The root map plus any per-project maps Claude Code has written. */
  private containers(): string[][] {
    const containers = [[this.rootKey]];
    const projects = this.document["projects"];
    if (isRecord(projects)) {
      for (const [name, project] of Object.entries(projects)) {
        if (isRecord(project) && isRecord(project[this.rootKey])) {
          containers.push(["projects", name, this.rootKey]);
        }
      }
    }
    return containers;
  }

  private resolve(container: string[]): Record<string, unknown> | null {
    let node: Record<string, unknown> = this.document;
    for (const segment of container) {
      const next = node[segment];
      if (!isRecord(next)) return null;
      node = next;
    }
    return node;
  }
}

const RMCP_FLAG = "experimental_use_rmcp_client";

/**
 * Codex keeps its servers in TOML. Rather than round-tripping the whole file
 * through a parser and losing comments and formatting, this edits the lines
 * belonging to a single `[mcp_servers.name]` table and leaves everything else
 * byte for byte as the user wrote it.
 */
class CodexConfigDocument implements ConfigDocument {
  readonly format: ConfigFormat = "toml-codex";
  private lines: string[];

  constructor(
    readonly path: string,
    raw: string,
  ) {
    this.lines = raw === "" ? [] : raw.replace(/\n$/u, "").split("\n");
  }

  servers(): ServerInventory {
    const inventory: ServerInventory = { remote: [], local: [] };
    for (const table of this.tables()) {
      const url = this.readString(table, "url");
      if (url) {
        inventory.remote.push({
          name: table.name,
          url,
          container: ["mcp_servers"],
          transport: null,
        });
        continue;
      }
      const command = this.readString(table, "command");
      if (command) {
        inventory.local.push({ name: table.name, container: ["mcp_servers"], command });
      }
    }
    return inventory;
  }

  upsertGateway(spec: GatewayEntrySpec): void {
    this.ensureRmcpFlag();
    const block = [
      `[mcp_servers.${tomlKey(spec.name)}]`,
      `url = ${tomlString(spec.url)}`,
      ...(spec.bearerTokenEnvVar
        ? [`bearer_token_env_var = ${tomlString(spec.bearerTokenEnvVar)}`]
        : spec.bearerToken
          ? [`bearer_token = ${tomlString(spec.bearerToken)}`]
          : []),
    ];
    const existing = this.tables().find((table) => table.name === spec.name);
    if (existing) {
      this.lines.splice(existing.start, existing.end - existing.start + 1, ...block);
      return;
    }
    if (this.lines.length > 0 && this.lines.at(-1)?.trim() !== "") this.lines.push("");
    this.lines.push(...block);
  }

  removeServer(ref: ServerRef): void {
    const table = this.tables().find((candidate) => candidate.name === ref.name);
    if (!table) return;
    this.lines.splice(table.start, table.end - table.start + 1);
    while (this.lines.at(-1)?.trim() === "") this.lines.pop();
  }

  serialize(): string {
    return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
  }

  /**
   * Codex only speaks Streamable HTTP when the RMCP client is enabled, and it
   * only reads the flag if it appears before the first table header.
   */
  private ensureRmcpFlag(): void {
    const firstHeader = this.lines.findIndex((line) => line.trimStart().startsWith("["));
    const limit = firstHeader === -1 ? this.lines.length : firstHeader;
    for (let index = 0; index < limit; index += 1) {
      const line = this.lines[index] ?? "";
      if (!new RegExp(`^\\s*${RMCP_FLAG}\\s*=`, "u").test(line)) continue;
      this.lines[index] = `${RMCP_FLAG} = true`;
      return;
    }
    this.lines.splice(limit, 0, `${RMCP_FLAG} = true`, "");
  }

  private tables(): TomlTable[] {
    const headers: { name: string | null; segments: string[]; line: number }[] = [];
    this.lines.forEach((line, index) => {
      if (!line.trimStart().startsWith("[")) return;
      const segments = parseTableHeader(line);
      headers.push({ name: segments?.[1] ?? null, segments: segments ?? [], line: index });
    });

    const tables: TomlTable[] = [];
    headers.forEach((header, position) => {
      if (header.segments[0] !== "mcp_servers" || header.segments.length !== 2) return;
      const name = header.name;
      if (name === null) return;
      // A table runs until the next header that is not one of its children,
      // so `[mcp_servers.x.env]` stays part of `x`.
      let end = this.lines.length - 1;
      for (let next = position + 1; next < headers.length; next += 1) {
        const candidate = headers[next];
        if (!candidate) break;
        const isChild =
          candidate.segments.length > 2 &&
          candidate.segments[0] === "mcp_servers" &&
          candidate.segments[1] === name;
        if (isChild) continue;
        end = candidate.line - 1;
        break;
      }
      while (end > header.line && this.lines[end]?.trim() === "") end -= 1;
      tables.push({ name, start: header.line, end });
    });
    return tables;
  }

  private readString(table: TomlTable, key: string): string | null {
    const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "u");
    for (let index = table.start + 1; index <= table.end; index += 1) {
      const line = this.lines[index] ?? "";
      if (line.trimStart().startsWith("[")) break;
      const match = pattern.exec(line);
      if (match) return parseTomlString(match[1] ?? "");
    }
    return null;
  }
}

interface TomlTable {
  name: string;
  start: number;
  end: number;
}

/** `[a.b]` or `[a."b.c"]` into its segments; null for anything else. */
export function parseTableHeader(line: string): string[] | null {
  const trimmed = line.trim().replace(/\s*#.*$/u, "");
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]") || trimmed.startsWith("[[")) {
    return null;
  }
  const body = trimmed.slice(1, -1);
  const segments: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (body[index] === " " || body[index] === "\t") index += 1;
    if (body[index] === '"' || body[index] === "'") {
      const quote = body[index] as string;
      const end = body.indexOf(quote, index + 1);
      if (end === -1) return null;
      segments.push(body.slice(index + 1, end));
      index = end + 1;
    } else {
      let end = index;
      while (end < body.length && body[end] !== ".") end += 1;
      const segment = body.slice(index, end).trim();
      if (segment === "") return null;
      segments.push(segment);
      index = end;
    }
    while (body[index] === " " || body[index] === "\t") index += 1;
    if (body[index] === ".") index += 1;
    else if (index < body.length) return null;
  }
  return segments.length === 0 ? null : segments;
}

function parseTomlString(raw: string): string | null {
  const text = raw.trim();
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    return end === -1 ? null : text.slice(1, end);
  }
  if (!text.startsWith('"')) return null;
  let index = 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') break;
    index += 1;
  }
  if (index >= text.length) return null;
  try {
    return JSON.parse(text.slice(0, index + 1)) as string;
  } catch {
    return text.slice(1, index);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** TOML bare keys allow letters, digits, underscores and dashes. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name);
}

/**
 * VS Code and Cursor both tolerate comments in their MCP files, so they have
 * to be removed before JSON.parse sees them. Anything inside a string stays.
 */
export function stripJsonComments(raw: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < raw.length) {
    const character = raw[index] as string;
    if (inString) {
      output += character;
      if (character === "\\") {
        output += raw[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && raw[index + 1] === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && raw[index + 1] === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function detectIndent(raw: string): string {
  return /^([ \t]+)\S/mu.exec(raw)?.[1] ?? "  ";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
