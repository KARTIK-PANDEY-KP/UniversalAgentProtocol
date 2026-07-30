import { GatewayError } from "@uap/core";
import { Metric, type MetricsRegistry } from "@uap/observability";

import {
  decodeEnvelope,
  envelopeDecrypt,
  envelopeEncrypt,
  type KeyProvider,
} from "./envelope.js";

/**
 * Every secret is stored under a purpose so that a ciphertext for one field
 * cannot be pasted into another, and under a tenant so that a ciphertext
 * cannot be moved between tenants. Both values are bound as additional
 * authenticated data.
 */
export type CredentialPurpose =
  | "access_token"
  | "refresh_token"
  | "client_secret"
  | "registration_access_token"
  | "pkce_verifier"
  | "static_headers"
  | "dpop_key";

export interface EncryptionContext {
  tenantId: string;
  purpose: CredentialPurpose;
}

function aadFor(context: EncryptionContext): Buffer {
  // The prefix is a domain separator, not a label: it is sealed into every
  // ciphertext, so changing it makes stored credentials undecryptable. Bump the
  // version and rewrap rather than editing it in place.
  return Buffer.from(`uap:v1:${context.tenantId}:${context.purpose}`, "utf8");
}

export class CredentialVault {
  constructor(
    private keys: KeyProvider,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /**
   * Installs a key ring whose active key has changed. The replacement must
   * still contain every key that existing ciphertext was sealed under, so
   * stored credentials stay readable until a rewrap pass has moved them.
   */
  rotateKeyring(keys: KeyProvider): void {
    this.keys = keys;
  }

  async encrypt(context: EncryptionContext, plaintext: string): Promise<string> {
    return envelopeEncrypt(this.keys, plaintext, aadFor(context));
  }

  async decrypt(context: EncryptionContext, ciphertext: string): Promise<string> {
    try {
      return await envelopeDecrypt(this.keys, ciphertext, aadFor(context));
    } catch (cause) {
      this.metrics?.counter(Metric.TokenDecryptionFailed, {
        purpose: context.purpose,
      });
      throw new GatewayError(
        "INTERNAL",
        `Unable to decrypt ${context.purpose} for the requested tenant`,
        { cause },
      );
    }
  }

  async encryptOptional(
    context: EncryptionContext,
    plaintext: string | null | undefined,
  ): Promise<string | null> {
    if (plaintext === null || plaintext === undefined) return null;
    return this.encrypt(context, plaintext);
  }

  async decryptOptional(
    context: EncryptionContext,
    ciphertext: string | null | undefined,
  ): Promise<string | null> {
    if (ciphertext === null || ciphertext === undefined) return null;
    return this.decrypt(context, ciphertext);
  }

  /** Re-encrypts under the currently active key; used by key rotation jobs. */
  async rewrap(context: EncryptionContext, ciphertext: string): Promise<string> {
    const plaintext = await this.decrypt(context, ciphertext);
    return this.encrypt(context, plaintext);
  }

  needsRewrap(ciphertext: string): boolean {
    return decodeEnvelope(ciphertext).keyId !== this.keys.activeKeyId();
  }
}
