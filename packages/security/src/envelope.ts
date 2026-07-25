import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { GatewayError } from "@uap/core";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Abstraction over the key management system that protects data encryption
 * keys. `LocalKeyring` is the development implementation; a KMS or HSM backed
 * provider implements the same two operations without any other change.
 */
export interface KeyProvider {
  activeKeyId(): string;
  keyIds(): string[];
  wrap(keyId: string, dataKey: Buffer): Promise<Buffer>;
  unwrap(keyId: string, wrapped: Buffer): Promise<Buffer>;
}

export class LocalKeyring implements KeyProvider {
  private readonly keys: Map<string, Buffer>;
  private readonly active: string;

  constructor(keys: Record<string, Buffer>, activeKeyId: string) {
    this.keys = new Map(Object.entries(keys));
    if (!this.keys.has(activeKeyId)) {
      throw new GatewayError("INTERNAL", `Unknown active key id: ${activeKeyId}`);
    }
    for (const [id, key] of this.keys) {
      if (key.length !== KEY_BYTES) {
        throw new GatewayError("INTERNAL", `Key ${id} must be 32 bytes`);
      }
    }
    this.active = activeKeyId;
  }

  /** Parses `kid:base64,kid:base64` with the first entry as the active key. */
  static fromSpec(spec: string): LocalKeyring {
    const keys: Record<string, Buffer> = {};
    let active: string | undefined;
    for (const entry of spec.split(",").map((part) => part.trim()).filter(Boolean)) {
      const separator = entry.indexOf(":");
      if (separator <= 0) {
        throw new GatewayError("INTERNAL", "Malformed key ring entry");
      }
      const kid = entry.slice(0, separator);
      keys[kid] = Buffer.from(entry.slice(separator + 1), "base64");
      active ??= kid;
    }
    if (!active) throw new GatewayError("INTERNAL", "Empty key ring");
    return new LocalKeyring(keys, active);
  }

  static generate(keyId = "local-1"): LocalKeyring {
    return new LocalKeyring({ [keyId]: randomBytes(KEY_BYTES) }, keyId);
  }

  activeKeyId(): string {
    return this.active;
  }

  keyIds(): string[] {
    return [...this.keys.keys()];
  }

  withRotatedKey(keyId: string): LocalKeyring {
    const keys: Record<string, Buffer> = {};
    for (const [id, key] of this.keys) keys[id] = key;
    keys[keyId] = randomBytes(KEY_BYTES);
    return new LocalKeyring(keys, keyId);
  }

  async wrap(keyId: string, dataKey: Buffer): Promise<Buffer> {
    const kek = this.requireKey(keyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, kek, iv);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async unwrap(keyId: string, wrapped: Buffer): Promise<Buffer> {
    const kek = this.requireKey(keyId);
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + 16);
    const ciphertext = wrapped.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private requireKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new GatewayError("INTERNAL", `Key ${keyId} is not present in the key ring`);
    }
    return key;
  }
}

export interface EnvelopeParts {
  version: string;
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const ENVELOPE_VERSION = "v1";

export function encodeEnvelope(parts: EnvelopeParts): string {
  return [
    parts.version,
    parts.keyId,
    parts.wrappedKey.toString("base64url"),
    parts.iv.toString("base64url"),
    parts.tag.toString("base64url"),
    parts.ciphertext.toString("base64url"),
  ].join(".");
}

export function decodeEnvelope(value: string): EnvelopeParts {
  const segments = value.split(".");
  if (segments.length !== 6 || segments[0] !== ENVELOPE_VERSION) {
    throw new GatewayError("INTERNAL", "Malformed ciphertext envelope");
  }
  return {
    version: segments[0],
    keyId: segments[1] ?? "",
    wrappedKey: Buffer.from(segments[2] ?? "", "base64url"),
    iv: Buffer.from(segments[3] ?? "", "base64url"),
    tag: Buffer.from(segments[4] ?? "", "base64url"),
    ciphertext: Buffer.from(segments[5] ?? "", "base64url"),
  };
}

export async function envelopeEncrypt(
  provider: KeyProvider,
  plaintext: string,
  aad: Buffer,
): Promise<string> {
  const keyId = provider.activeKeyId();
  const dataKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const wrappedKey = await provider.wrap(keyId, dataKey);
  dataKey.fill(0);
  return encodeEnvelope({
    version: ENVELOPE_VERSION,
    keyId,
    wrappedKey,
    iv,
    tag: cipher.getAuthTag(),
    ciphertext,
  });
}

export async function envelopeDecrypt(
  provider: KeyProvider,
  value: string,
  aad: Buffer,
): Promise<string> {
  const parts = decodeEnvelope(value);
  const dataKey = await provider.unwrap(parts.keyId, parts.wrappedKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, parts.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([
      decipher.update(parts.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}
