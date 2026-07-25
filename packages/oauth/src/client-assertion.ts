import { createSign, randomUUID } from "node:crypto";

import { base64url } from "@umg/core";
import type { SigningKey } from "@umg/security";

export interface ClientAssertionParams {
  clientId: string;
  audience: string;
  key: SigningKey;
  nowSeconds: number;
  lifetimeSeconds?: number;
}

export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Builds the RFC 7523 assertion used for `private_key_jwt` client
 * authentication. The signature is emitted in JOSE (R||S) form rather than
 * DER, which is what ES256 verifiers expect.
 */
export function createClientAssertion(params: ClientAssertionParams): string {
  const header = { alg: "ES256", typ: "JWT", kid: params.key.kid };
  const payload = {
    iss: params.clientId,
    sub: params.clientId,
    aud: params.audience,
    jti: randomUUID(),
    iat: params.nowSeconds,
    exp: params.nowSeconds + (params.lifetimeSeconds ?? 300),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  const signature = signer.sign({
    key: params.key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}
