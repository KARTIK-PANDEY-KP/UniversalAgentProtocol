import { sha256Hex } from "./crypto.js";
import type { JsonObject, JsonValue } from "./json-rpc.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows an arbitrary structure that is already known to be JSON-compatible
 * into the `JsonObject` shape used across the JSON-RPC layer. Undefined
 * properties are dropped so the value survives serialisation unchanged.
 */
export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError("Expected a JSON object");
  }
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item as JsonValue;
  }
  return result;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Serialises with sorted keys, so two structures that differ only in property
 * order hash the same. Tool schemas arrive in whatever order an upstream feels
 * like, and reordering is not a change worth telling clients about.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

export function schemaHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
