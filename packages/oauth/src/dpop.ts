import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import { base64url, type AuthorizationServerMetadata } from "@umg/core";

/** An ES256 key pair bound to one upstream connection. */
export interface DpopKey {
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
}

export interface DpopProofParams {
  key: DpopKey;
  /** The HTTP method of the request the proof accompanies. */
  htm: string;
  /** The request URI; query and fragment are stripped per RFC 9449. */
  htu: string;
  nowSeconds: number;
  /** Server-supplied nonce, when one has been demanded. */
  nonce?: string | undefined;
  /** The access token being presented, for the `ath` claim. */
  accessToken?: string | undefined;
}

const DPOP_ALG = "ES256";

export function generateDpopKey(): { key: DpopKey; privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    key: toDpopKey(privateKey),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function dpopKeyFromPem(pem: string): DpopKey {
  return toDpopKey(createPrivateKey(pem));
}

function toDpopKey(privateKey: KeyObject): DpopKey {
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  // The proof header carries the public key only; leaking `d` would hand over
  // the very thing that binds the token to us.
  return {
    privateKey,
    publicJwk: { kty: jwk["kty"], crv: jwk["crv"], x: jwk["x"], y: jwk["y"] },
  };
}

/** RFC 9449 proof-of-possession JWT for a single HTTP request. */
export function createDpopProof(params: DpopProofParams): string {
  const header = { typ: "dpop+jwt", alg: DPOP_ALG, jwk: params.key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: randomUUID(),
    htm: params.htm.toUpperCase(),
    htu: canonicalHtu(params.htu),
    iat: params.nowSeconds,
  };
  if (params.nonce) payload["nonce"] = params.nonce;
  if (params.accessToken) payload["ath"] = accessTokenHash(params.accessToken);

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

/** The `htu` claim is the target URI with query and fragment removed. */
export function canonicalHtu(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken, "ascii").digest("base64url");
}

/** The JWK thumbprint an authorization server binds the token to. */
export function jwkThumbprint(publicJwk: Record<string, unknown>): string {
  const canonical = JSON.stringify({
    crv: publicJwk["crv"],
    kty: publicJwk["kty"],
    x: publicJwk["x"],
    y: publicJwk["y"],
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

/**
 * True when the authorization server advertises DPoP. The gateway only offers
 * sender-constrained tokens where they are supported, never as a guess.
 */
export function supportsDpop(metadata: AuthorizationServerMetadata): boolean {
  const algorithms = metadata.dpop_signing_alg_values_supported;
  return Array.isArray(algorithms) && algorithms.includes(DPOP_ALG);
}
