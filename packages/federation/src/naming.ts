import { sha256Hex } from "@umg/core";

const MAX_TOOL_NAME = 128;
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
    .replace(/[^a-z0-9]+$/u, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "server";
}

export function isValidAlias(value: string): boolean {
  return ALIAS_PATTERN.test(value);
}

export function dedupeAlias(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}_${sha256Hex(base).slice(0, 6)}`;
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
  // Two upstream names normalised onto the same gateway name: keep both
  // reachable with a deterministic suffix derived from the upstream name.
  const suffix = sha256Hex(upstreamName).slice(0, 8);
  return `${base.slice(0, MAX_TOOL_NAME - suffix.length - 1)}_${suffix}`;
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
