import { createHash, createPublicKey, createVerify } from "node:crypto";

/** What a verified DPoP proof told us. */
export interface VerifiedProof {
  /** JWK thumbprint of the key that signed it; the value a token binds to. */
  thumbprint: string;
  htm: string;
  htu: string;
  jti: string;
  nonce: string | undefined;
  /** Hash of the access token the proof was presented with, when present. */
  ath: string | undefined;
}

export class DpopProofError extends Error {}

/**
 * Verifies an RFC 9449 proof the way a server would: the signature must match
 * the embedded public key, and the method and URI must match the request the
 * proof arrived on. Written for the conformance harness, so it is strict about
 * the parts the gateway is being tested on and tolerant about clock skew.
 */
export function verifyDpopProof(
  proof: string | undefined,
  expected: { htm: string; htu: string; accessToken?: string; nonce?: string },
): VerifiedProof {
  if (!proof) throw new DpopProofError("missing DPoP proof");
  const [headerPart, payloadPart, signaturePart] = proof.split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new DpopProofError("malformed DPoP proof");
  }

  const header = decode(headerPart);
  if (header["typ"] !== "dpop+jwt") throw new DpopProofError("wrong proof type");
  if (header["alg"] !== "ES256") throw new DpopProofError("unsupported proof algorithm");
  const jwk = header["jwk"];
  if (!isRecord(jwk)) throw new DpopProofError("proof carries no public key");
  if ("d" in jwk) throw new DpopProofError("proof leaked the private key");

  const verifier = createVerify("SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  const valid = verifier.verify(
    { key: createPublicKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signaturePart, "base64url"),
  );
  if (!valid) throw new DpopProofError("bad proof signature");

  const payload = decode(payloadPart);
  if (payload["htm"] !== expected.htm.toUpperCase()) {
    throw new DpopProofError(`proof htm ${String(payload["htm"])} != ${expected.htm}`);
  }
  if (canonical(String(payload["htu"] ?? "")) !== canonical(expected.htu)) {
    throw new DpopProofError(`proof htu ${String(payload["htu"])} != ${expected.htu}`);
  }
  if (expected.nonce !== undefined && payload["nonce"] !== expected.nonce) {
    throw new DpopProofError("proof carries the wrong nonce");
  }
  if (expected.accessToken !== undefined) {
    const ath = createHash("sha256")
      .update(expected.accessToken, "ascii")
      .digest("base64url");
    if (payload["ath"] !== ath) throw new DpopProofError("proof ath does not match the token");
  }

  return {
    thumbprint: thumbprintOf(jwk),
    htm: String(payload["htm"]),
    htu: String(payload["htu"]),
    jti: String(payload["jti"] ?? ""),
    nonce: typeof payload["nonce"] === "string" ? payload["nonce"] : undefined,
    ath: typeof payload["ath"] === "string" ? payload["ath"] : undefined,
  };
}

export function thumbprintOf(jwk: Record<string, unknown>): string {
  const canonicalJwk = JSON.stringify({
    crv: jwk["crv"],
    kty: jwk["kty"],
    x: jwk["x"],
    y: jwk["y"],
  });
  return createHash("sha256").update(canonicalJwk).digest("base64url");
}

function decode(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!isRecord(parsed)) throw new DpopProofError("proof segment is not an object");
  return parsed;
}

function canonical(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
