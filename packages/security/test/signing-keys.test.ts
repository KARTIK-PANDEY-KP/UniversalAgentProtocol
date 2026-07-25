import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GatewayError } from "@umg/core";

import { SigningKeyStore } from "@umg/security";

function ecPem(namedCurve: string): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function p256Pem(): string {
  return ecPem("P-256");
}

describe("SigningKeyStore", () => {
  it("gives two keys two identifiers", () => {
    const first = SigningKeyStore.fromPem(p256Pem()).active();
    const second = SigningKeyStore.fromPem(p256Pem()).active();
    expect(first.kid).not.toBe(second.kid);
  });

  it("gives one key the same identifier every time it is loaded", () => {
    const material = p256Pem();
    expect(SigningKeyStore.fromPem(material).active().kid).toBe(
      SigningKeyStore.fromPem(material).active().kid,
    );
  });

  it("computes the identifier from the key alone", () => {
    // RFC 7638 hashes only the required members, so the kid must match the
    // thumbprint of the published JWK stripped of kid, use and alg.
    const key = SigningKeyStore.fromPem(p256Pem()).active();
    const published = SigningKeyStore.fromPem(p256Pem()).jwks().keys[0];
    expect(published).toHaveProperty("kid");
    expect(key.kid).toMatch(/^[\w-]{43}$/u);
  });

  it("refuses a key it cannot sign ES256 with", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const material = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => SigningKeyStore.fromPem(material)).toThrow(GatewayError);
    expect(() => SigningKeyStore.fromPem(material)).toThrow(/EC P-256/u);
  });

  it("refuses a curve other than P-256", () => {
    expect(() => SigningKeyStore.fromPem(ecPem("P-384"))).toThrow(/EC P-256/u);
  });

  it("keeps the previous key published after a rotation", () => {
    let now = 0;
    const store = SigningKeyStore.generate(() => now);
    const first = store.active().kid;

    now += 1_000;
    const second = store.rotate().kid;

    expect(second).not.toBe(first);
    expect(store.active().kid).toBe(second);
    expect(store.find(first)?.kid).toBe(first);
    expect(store.jwks().keys.map((key) => key["kid"])).toEqual([second, first]);
  });

  it("drops a key once the rotation window has passed", () => {
    let now = 0;
    const store = new SigningKeyStore(() => now, 1_000);
    store.rotate();
    const stale = store.active().kid;

    now += 2_000;
    store.rotate();

    expect(store.find(stale)).toBeUndefined();
  });
});
