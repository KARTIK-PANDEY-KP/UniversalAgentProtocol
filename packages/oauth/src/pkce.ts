import { randomBytes } from "node:crypto";

import { sha256Base64Url } from "@umg/core";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * RFC 7636 verifier: 43 characters of base64url entropy. Only S256 is offered;
 * `plain` is never used even when an authorization server advertises it.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: sha256Base64Url(verifier), method: "S256" };
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return sha256Base64Url(verifier) === challenge;
}
