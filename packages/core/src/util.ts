import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { JsonObject, JsonValue } from "./json-rpc.js";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64url");
}

export function sha256(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

export function sha256Hex(input: string | Buffer): string {
  return sha256(input).toString("hex");
}

export function sha256Base64Url(input: string | Buffer): string {
  return sha256(input).toString("base64url");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Deterministic JSON stringify used for schema hashing. */
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function jitteredBackoff(
  attempt: number,
  baseMs = 250,
  maxMs = 30_000,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

export function parseScopes(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/u).filter((scope) => scope.length > 0);
}

export function formatScopes(scopes: readonly string[]): string {
  return scopes.join(" ");
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Truncates untrusted text before it reaches logs or persisted error fields. */
export function clampText(value: string, max = 512): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
