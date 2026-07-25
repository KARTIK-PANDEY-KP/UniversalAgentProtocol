import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import type { ServerResponse } from "node:http";

import { HttpFixture, json, type FixtureRequest } from "./http-fixture.js";

export interface MockIdentityProviderOptions {
  /** Signing algorithm for issued tokens; the key type follows from it. */
  algorithm?: "RS256" | "ES256";
  accessTokenTtlSeconds?: number;
  /** Omit `jwks_uri` from the metadata, as a misconfigured provider would. */
  omitJwks?: boolean;
}

export interface IssueTokenOptions {
  subject?: string;
  audience?: string | string[];
  scope?: string;
  /** Seconds from now; negative values mint an already-expired token. */
  expiresInSeconds?: number;
  notBeforeSeconds?: number;
  issuer?: string;
  /** Merged over the standard claims, so a test can add or remove any of them. */
  claims?: Record<string, unknown>;
  /**
   * Sign with a key this provider does not publish, while still naming the
   * published key in the header: the shape a forged token actually takes.
   */
  signWithForeignKey?: boolean;
  /** Replace the `alg` header without changing how the token is signed. */
  algorithmHeader?: string;
  keyId?: string;
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
}

/**
 * An OpenID-style provider that mints JWT access tokens and publishes the keys
 * to verify them.
 *
 * The upstream mock authorization server deliberately issues opaque tokens,
 * because that is what the gateway consumes as an OAuth client. This fixture
 * exists for the other direction: proving the gateway behaves like a resource
 * server when a downstream client presents a token of its own.
 */
export class MockIdentityProvider {
  private readonly fixture: HttpFixture;
  private keys: SigningKey[] = [];
  private foreign: SigningKey;

  /** Counts JWKS fetches so a test can assert the key set is cached. */
  jwksRequests = 0;

  constructor(private readonly options: MockIdentityProviderOptions = {}) {
    this.fixture = new HttpFixture((request, res) => this.route(request, res));
    this.keys = [this.newKey()];
    this.foreign = this.newKey();
  }

  get issuer(): string {
    return this.fixture.baseUrl;
  }

  async start(): Promise<string> {
    return this.fixture.start();
  }

  async stop(): Promise<void> {
    await this.fixture.stop();
  }

  /** Retires the active key and starts signing with a fresh one. */
  rotateKey(): void {
    this.keys = [this.newKey()];
  }

  issueToken(options: IssueTokenOptions = {}): string {
    const key = options.signWithForeignKey ? this.foreign : this.activeKey;
    const advertisedKid = options.keyId ?? this.activeKey.kid;
    const now = Math.floor(Date.now() / 1000);
    const ttl = options.expiresInSeconds ?? this.options.accessTokenTtlSeconds ?? 3600;
    const standard: Record<string, unknown> = {
      iss: options.issuer ?? this.issuer,
      sub: options.subject ?? "user-1",
      aud: options.audience ?? "",
      exp: now + ttl,
      iat: now,
      jti: randomUUID(),
    };
    if (options.scope !== undefined) standard["scope"] = options.scope;
    if (options.notBeforeSeconds !== undefined) {
      standard["nbf"] = now + options.notBeforeSeconds;
    }
    const claims = { ...standard, ...(options.claims ?? {}) };
    for (const [name, value] of Object.entries(claims)) {
      if (value === undefined) delete claims[name];
    }

    const header = {
      typ: "at+jwt",
      alg: options.algorithmHeader ?? this.algorithm,
      kid: advertisedKid,
    };
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signature = sign(
      this.algorithm === "ES256" ? "sha256" : "sha256",
      Buffer.from(signingInput, "utf8"),
      this.algorithm === "ES256"
        ? { key: key.privateKey, dsaEncoding: "ieee-p1363" }
        : key.privateKey,
    );
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      ...(this.options.omitJwks ? {} : { jwks_uri: `${this.issuer}/jwks` }),
    };
  }

  private get algorithm(): "RS256" | "ES256" {
    return this.options.algorithm ?? "RS256";
  }

  private get activeKey(): SigningKey {
    return this.keys[0] as SigningKey;
  }

  private newKey(): SigningKey {
    const { privateKey, publicKey } =
      this.algorithm === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "P-256" })
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = randomUUID();
    return {
      kid,
      privateKey,
      publicJwk: {
        ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
        kid,
        use: "sig",
        alg: this.algorithm,
      },
    };
  }

  private route(request: FixtureRequest, res: ServerResponse): void {
    const path = request.url.pathname;
    if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(res, 200, this.metadata(), { "cache-control": "no-store" });
      return;
    }
    if (request.method === "GET" && path === "/jwks") {
      this.jwksRequests += 1;
      json(res, 200, { keys: this.keys.map((key) => key.publicJwk) });
      return;
    }
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
