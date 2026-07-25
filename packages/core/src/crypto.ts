import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Prefixed identifiers, so a value that leaks into a log says what it is. */
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

/**
 * Compares two secrets without leaking their contents through how long the
 * comparison took. Length is compared first and is not itself secret.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
