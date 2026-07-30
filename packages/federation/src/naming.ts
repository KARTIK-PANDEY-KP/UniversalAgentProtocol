import { isRecord, sha256Hex, type JsonObject, type JsonValue } from "@uap/core";

const MAX_TOOL_NAME = 128;
const MAX_ALIAS = 40;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,38}[a-z0-9]$|^[a-z0-9]$/u;

/**
 * Derives a default alias from the host label. The alias is nothing more than
 * a user-editable label: no behaviour is ever selected from it, and the user
 * can rename it at any time.
 */
export function defaultAliasFor(mcpUrl: string, taken: readonly string[]): string {
  let base: string;
  try {
    const host = new URL(mcpUrl).hostname.toLowerCase();
    const labels = host.split(".").filter((label) => label.length > 0);
    const meaningful = labels.filter(
      (label) => !["www", "api", "mcp", "com", "net", "org", "io", "dev", "ai"].includes(label),
    );
    base = sanitizeAlias(meaningful[0] ?? labels[0] ?? "server");
  } catch {
    base = "server";
  }
  return dedupeAlias(base, taken);
}

export function sanitizeAlias(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    // Truncated before the trailing separators are stripped, or a cut landing
    // on a dash would leave one at the end and fail isValidAlias.
    .slice(0, MAX_ALIAS)
    .replace(/[^a-z0-9]+$/u, "");
  return cleaned.length > 0 ? cleaned : "server";
}

export function isValidAlias(value: string): boolean {
  return ALIAS_PATTERN.test(value);
}

/** Trims a base so that `base + suffix` still fits an alias. */
function roomFor(base: string, suffix: string): string {
  const kept = base.slice(0, MAX_ALIAS - suffix.length).replace(/[^a-z0-9]+$/u, "");
  return kept.length > 0 ? kept : "server";
}

export function dedupeAlias(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${roomFor(base, `_${suffix}`)}_${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  const digest = `_${sha256Hex(base).slice(0, 6)}`;
  return `${roomFor(base, digest)}${digest}`;
}

/** MCP tool names accept letters, digits, underscore, dash and dot. */
export function normalizeToolSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]+/gu, "_");
  return cleaned.length > 0 ? cleaned : "tool";
}

export function gatewayToolName(
  alias: string,
  upstreamName: string,
  taken: ReadonlySet<string>,
): string {
  const base = `${alias}.${normalizeToolSegment(upstreamName)}`.slice(0, MAX_TOOL_NAME);
  if (!taken.has(base)) return base;
  // Two upstream names normalised or truncated onto the same gateway name:
  // keep both reachable behind a suffix derived from the upstream name. The
  // counter covers the case the digest cannot, which is two tools whose
  // upstream names are also identical.
  const digest = sha256Hex(upstreamName).slice(0, 8);
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? `_${digest}` : `_${digest}_${attempt}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function gatewayPromptName(alias: string, upstreamName: string): string {
  return `${alias}/${upstreamName}`;
}

export function splitPromptName(
  gatewayName: string,
): { alias: string; upstreamName: string } | null {
  const index = gatewayName.indexOf("/");
  if (index <= 0) return null;
  return {
    alias: gatewayName.slice(0, index),
    upstreamName: gatewayName.slice(index + 1),
  };
}

/**
 * Namespaces a resource URI without destroying the upstream form:
 * `file:///notes.md` under alias `docs` becomes `docs+file:///notes.md`.
 */
export function gatewayResourceUri(alias: string, upstreamUri: string): string {
  const schemeEnd = upstreamUri.indexOf(":");
  if (schemeEnd <= 0) return `${alias}+opaque:${upstreamUri}`;
  return `${alias}+${upstreamUri}`;
}

/**
 * Rewrites the resource URIs carried inside a result so they name the
 * gateway's copy rather than the upstream's. A tool that answers with a
 * resource link is inviting the client to read it, and the client can only
 * reach it back through the gateway; handing over the upstream's own URI
 * offers a door that does not open.
 *
 * Only the shapes the protocol defines are touched. A `uri` that happens to
 * appear in a tool's own payload is data, not a reference, and rewriting it
 * would corrupt the answer.
 */
export function namespaceResultResources(result: JsonObject, alias: string): JsonObject {
  const out: JsonObject = { ...result };
  if (Array.isArray(out["content"])) {
    out["content"] = out["content"].map((block) => namespaceBlock(block, alias));
  }
  if (Array.isArray(out["contents"])) {
    out["contents"] = out["contents"].map((entry) => namespaceContents(entry, alias));
  }
  if (Array.isArray(out["messages"])) {
    out["messages"] = out["messages"].map((message) =>
      isRecord(message) && "content" in message
        ? { ...message, content: namespaceBlock(message["content"], alias) }
        : message,
    );
  }
  return out;
}

function namespaceBlock(block: JsonValue | undefined, alias: string): JsonValue {
  if (Array.isArray(block)) return block.map((item) => namespaceBlock(item, alias));
  if (!isRecord(block)) return block ?? null;
  if (block["type"] === "resource_link" && typeof block["uri"] === "string") {
    return { ...block, uri: gatewayResourceUri(alias, block["uri"]) };
  }
  if (block["type"] === "resource") {
    return { ...block, resource: namespaceContents(block["resource"], alias) };
  }
  return block;
}

function namespaceContents(entry: JsonValue | undefined, alias: string): JsonValue {
  if (!isRecord(entry) || typeof entry["uri"] !== "string") return entry ?? null;
  return { ...entry, uri: gatewayResourceUri(alias, entry["uri"]) };
}

export function splitResourceUri(
  gatewayUri: string,
): { alias: string; upstreamUri: string } | null {
  const plus = gatewayUri.indexOf("+");
  if (plus <= 0) return null;
  const alias = gatewayUri.slice(0, plus);
  const remainder = gatewayUri.slice(plus + 1);
  if (remainder.startsWith("opaque:")) {
    return { alias, upstreamUri: remainder.slice("opaque:".length) };
  }
  return { alias, upstreamUri: remainder };
}
