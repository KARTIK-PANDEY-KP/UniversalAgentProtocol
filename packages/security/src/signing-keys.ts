import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

import { GatewayError } from "@uap/core";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
  createdAt: number;
}

export interface JsonWebKeySet {
  keys: Record<string, unknown>[];
}

/**
 * The members RFC 7638 requires for each key type, in the lexicographic order
 * the specification prescribes. Every other member — `kid`, `use`, `alg` — is
 * excluded, which is what makes the thumbprint an identity for the key rather
 * than for the document describing it.
 */
const THUMBPRINT_MEMBERS: Record<string, readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
};

/** RFC 7638 JWK thumbprint, SHA-256, base64url. */
function thumbprint(publicJwk: Record<string, unknown>): string {
  const kty = publicJwk["kty"];
  const members = typeof kty === "string" ? THUMBPRINT_MEMBERS[kty] : undefined;
  if (!members) {
    throw new GatewayError("INTERNAL", `Cannot compute a thumbprint for a ${String(kty)} key`);
  }
  const canonical: Record<string, unknown> = {};
  for (const member of members) {
    const value = publicJwk[member];
    if (typeof value !== "string") {
      throw new GatewayError("INTERNAL", `Key is missing the required member ${member}`);
    }
    canonical[member] = value;
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
}

function toSigningKey(privateKey: KeyObject, createdAt: number): SigningKey {
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as Record<
    string,
    unknown
  >;
  // Everything that consumes these keys — client assertions and DPoP proofs —
  // signs ES256. A key of any other shape would produce assertions no
  // authorization server accepts, and it is better to say so at startup.
  if (publicJwk["kty"] !== "EC" || publicJwk["crv"] !== "P-256") {
    throw new GatewayError(
      "INTERNAL",
      "The gateway signs with ES256, so its signing key must be an EC P-256 key",
      { data: { kty: String(publicJwk["kty"]), crv: String(publicJwk["crv"] ?? "") } },
    );
  }
  return { kid: thumbprint(publicJwk), privateKey, publicJwk, createdAt };
}

/**
 * Holds the ES256 keys used for `private_key_jwt` client authentication. The
 * previous keys stay published in the JWKS during the rotation window so an
 * authorization server that cached the document keeps validating assertions.
 */
export class SigningKeyStore {
  private keys: SigningKey[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly rotationWindowMs = 7 * 24 * 60 * 60 * 1000,
  ) {}

  static generate(now: () => number = () => Date.now()): SigningKeyStore {
    const store = new SigningKeyStore(now);
    store.rotate();
    return store;
  }

  static fromPem(pem: string, now: () => number = () => Date.now()): SigningKeyStore {
    const store = new SigningKeyStore(now);
    store.keys.push(toSigningKey(createPrivateKey(pem), now()));
    return store;
  }

  active(): SigningKey {
    const key = this.keys[0];
    if (!key) throw new GatewayError("INTERNAL", "No signing key configured");
    return key;
  }

  find(kid: string): SigningKey | undefined {
    return this.keys.find((key) => key.kid === kid);
  }

  rotate(): SigningKey {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const key = toSigningKey(privateKey, this.now());
    this.keys = [key, ...this.keys].filter(
      (candidate, index) =>
        index === 0 || this.now() - candidate.createdAt < this.rotationWindowMs,
    );
    return key;
  }

  jwks(): JsonWebKeySet {
    return {
      keys: this.keys.map((key) => ({
        ...key.publicJwk,
        kid: key.kid,
        use: "sig",
        alg: "ES256",
      })),
    };
  }
}
