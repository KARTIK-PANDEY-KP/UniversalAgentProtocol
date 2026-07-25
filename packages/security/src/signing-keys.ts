import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

import { GatewayError } from "@umg/core";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
  createdAt: number;
}

export interface JsonWebKeySet {
  keys: Record<string, unknown>[];
}

function thumbprint(publicJwk: Record<string, unknown>): string {
  const canonical = JSON.stringify({
    crv: publicJwk["crv"],
    kty: publicJwk["kty"],
    x: publicJwk["x"],
    y: publicJwk["y"],
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

function toSigningKey(privateKey: KeyObject, createdAt: number): SigningKey {
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as Record<
    string,
    unknown
  >;
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
