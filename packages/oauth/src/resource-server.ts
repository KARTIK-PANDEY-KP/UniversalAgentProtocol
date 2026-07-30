import { constants, createPublicKey, verify, type KeyObject } from "node:crypto";

import {
  GatewayError,
  isRecord,
  parseScopes,
  type Clock,
  type JsonObject,
} from "@uap/core";
import type { Logger } from "@uap/observability";
import { canonicalizeUrl, sameIssuer, type SafeFetcher } from "@uap/security";

import type { OAuthDiscoveryService } from "./discovery.js";

export interface VerifiedAccessToken {
  issuer: string;
  subject: string;
  scopes: string[];
  /** The `client_id` claim when the authorization server sets one. */
  clientId: string | null;
  claims: JsonObject;
}

export interface ResourceServerOptions {
  discovery: OAuthDiscoveryService;
  fetcher: SafeFetcher;
  clock: Clock;
  logger: Logger;
  /** Issuers whose access tokens this gateway accepts. */
  issuers: readonly string[];
  /** The value a token's audience must contain: the gateway's MCP endpoint. */
  resource: string;
  /** A token must carry at least one of these; empty accepts any scope. */
  requiredScopes: readonly string[];
  allowHttp: boolean;
  jwksTtlMs?: number;
  /** Shortest gap between two key-set fetches for one issuer. */
  jwksRefetchCooldownMs?: number;
  clockSkewSeconds?: number;
}

interface KeySet {
  keys: JsonObject[];
  expiresAt: number;
  /** When an unknown key id last forced an early refetch of this set. */
  refetchedAt: number | null;
}

/**
 * Verifies bearer tokens presented to the gateway's own MCP and control-plane
 * endpoints.
 *
 * The gateway advertises itself as an OAuth protected resource, so it has to
 * behave like one: tokens are validated against the issuers the operator
 * configured, using keys fetched from those issuers, and are only accepted if
 * they were minted for this gateway. Skipping the audience check is what turns
 * a resource server into a confused deputy, because any token from a shared
 * authorization server would then unlock every resource that trusts it.
 */
export class ResourceServerAuthenticator {
  private readonly jwks = new Map<string, KeySet>();
  /** Fetches in progress, so a burst of misses costs one request, not many. */
  private readonly inFlight = new Map<string, Promise<JsonObject[]>>();

  constructor(private readonly options: ResourceServerOptions) {}

  /** True when the operator configured any authorization server at all. */
  get enabled(): boolean {
    return this.options.issuers.length > 0;
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    const { header, claims, signingInput, signature } = decodeJwt(token);

    const alg = header["alg"];
    if (typeof alg !== "string" || !(alg in ALGORITHMS)) {
      throw invalidToken(`Unsupported token signing algorithm: ${String(alg)}`);
    }
    // Anything the same issuer signs with a declared type of its own is some
    // other kind of JWT — an ID token, a DPoP proof, a security event — and
    // was not minted to authorize a call to this gateway.
    const typ = header["typ"];
    if (typeof typ === "string" && !ACCESS_TOKEN_TYPES.has(typ.toLowerCase())) {
      throw invalidToken(`A ${typ} is not an access token`);
    }

    const issuer = claims["iss"];
    if (typeof issuer !== "string") throw invalidToken("Token has no issuer");
    const configured = this.options.issuers.find((candidate) =>
      sameIssuer(candidate, issuer),
    );
    if (configured === undefined) {
      throw invalidToken(`Token issuer ${issuer} is not accepted by this gateway`);
    }

    const key = await this.signingKey(configured, header);
    if (!verifySignature(alg, key, signingInput, signature)) {
      throw invalidToken("Token signature does not verify");
    }

    this.checkLifetime(claims);
    this.checkAudience(claims);
    const scopes = this.checkScopes(claims);

    const subject = claims["sub"];
    if (typeof subject !== "string" || subject === "") {
      throw invalidToken("Token has no subject");
    }
    const clientId = claims["client_id"];
    return {
      // The configured spelling, not the token's: callers namespace subjects
      // by issuer, and two spellings of one issuer must not become two
      // namespaces.
      issuer: configured,
      subject,
      scopes,
      clientId: typeof clientId === "string" ? clientId : null,
      claims,
    };
  }

  private checkLifetime(claims: JsonObject): void {
    const skew = this.options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS;
    const now = Math.floor(this.options.clock.now() / 1000);
    const expiry = claims["exp"];
    // An access token without an expiry never stops being useful to whoever
    // steals it, so it is refused rather than trusted indefinitely.
    if (typeof expiry !== "number") throw invalidToken("Token has no expiry");
    if (expiry + skew <= now) throw invalidToken("Token has expired");
    const notBefore = claims["nbf"];
    if (typeof notBefore === "number" && notBefore - skew > now) {
      throw invalidToken("Token is not valid yet");
    }
  }

  private checkAudience(claims: JsonObject): void {
    const policy = { allowHttp: this.options.allowHttp };
    const expected = canonicalizeUrl(this.options.resource, policy);
    const raw = claims["aud"];
    const audiences = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : typeof raw === "string"
        ? [raw]
        : [];
    const matches = audiences.some((audience) => {
      try {
        return canonicalizeUrl(audience, policy) === expected;
      } catch {
        return audience === this.options.resource;
      }
    });
    if (!matches) {
      throw invalidToken(
        `Token was not issued for this gateway; its audience is ${
          audiences.join(", ") || "absent"
        }`,
      );
    }
  }

  private checkScopes(claims: JsonObject): string[] {
    const raw = claims["scope"];
    const scopes = typeof raw === "string" ? parseScopes(raw) : [];
    const required = this.options.requiredScopes;
    if (required.length > 0 && !required.some((scope) => scopes.includes(scope))) {
      throw new GatewayError(
        "FORBIDDEN",
        `Token needs one of these scopes: ${required.join(", ")}`,
        { data: { oauthError: "insufficient_scope", scope: required.join(" ") } },
      );
    }
    return scopes;
  }

  /**
   * Resolves the issuer's signing key, refetching the key set when a key id is
   * unknown so that a rotation does not lock every client out until the cache
   * expires.
   *
   * That early refetch is on a cooldown, because otherwise it is an
   * amplifier: an unauthenticated caller sending tokens with invented key ids
   * would turn each one into an outbound request to the operator's
   * authorization server. One rotation is followed immediately; a stream of
   * unknown key ids costs one fetch per cooldown and is refused in between.
   */
  private async signingKey(issuer: string, header: JsonObject): Promise<KeyObject> {
    const kid = typeof header["kid"] === "string" ? header["kid"] : null;
    const alg = String(header["alg"]);
    const now = this.options.clock.now();

    const unknownKey = (): GatewayError =>
      invalidToken(
        kid === null
          ? `Issuer ${issuer} publishes no key usable for ${alg}`
          : `Issuer ${issuer} publishes no key with id ${kid}`,
      );

    const cached = this.jwks.get(issuer);
    if (cached && cached.expiresAt > now) {
      const found = selectKey(cached.keys, kid, alg);
      if (found) return toKeyObject(found);
      const cooldown =
        this.options.jwksRefetchCooldownMs ?? DEFAULT_JWKS_REFETCH_COOLDOWN_MS;
      if (cached.refetchedAt !== null && now - cached.refetchedAt < cooldown) {
        throw unknownKey();
      }
      cached.refetchedAt = now;
    }

    const keys = await this.fetchJwks(issuer);
    const found = selectKey(keys, kid, alg);
    if (!found) throw unknownKey();
    return toKeyObject(found);
  }

  private async fetchJwks(issuer: string): Promise<JsonObject[]> {
    const pending = this.inFlight.get(issuer);
    if (pending) return pending;
    const fetching = this.loadJwks(issuer).finally(() => {
      this.inFlight.delete(issuer);
    });
    this.inFlight.set(issuer, fetching);
    return fetching;
  }

  private async loadJwks(issuer: string): Promise<JsonObject[]> {
    const { metadata } = await this.options.discovery.discoverAuthorizationServer(issuer);
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== "string") {
      throw invalidToken(`Issuer ${issuer} publishes no jwks_uri`);
    }
    const { value } = await this.options.fetcher.getJson(jwksUri);
    const keys = isRecord(value) ? value["keys"] : undefined;
    if (!Array.isArray(keys)) {
      throw invalidToken(`Key set at ${jwksUri} has no keys`);
    }
    const usable = keys.filter((entry): entry is JsonObject => isRecord(entry));
    const now = this.options.clock.now();
    this.jwks.set(issuer, {
      keys: usable,
      expiresAt: now + (this.options.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS),
      refetchedAt: this.jwks.get(issuer)?.refetchedAt ?? null,
    });
    this.options.logger.debug("Loaded a signing key set", {
      issuer,
      keys: usable.length,
    });
    return usable;
  }
}

const DEFAULT_JWKS_TTL_MS = 3_600_000;
/** Long enough to blunt the amplifier, short enough to survive a rotation. */
const DEFAULT_JWKS_REFETCH_COOLDOWN_MS = 60_000;
const DEFAULT_SKEW_SECONDS = 60;

/** RFC 9068 names access tokens `at+jwt`; plain `JWT` is what most still send. */
const ACCESS_TOKEN_TYPES = new Set(["jwt", "at+jwt", "application/at+jwt"]);

interface AlgorithmSpec {
  hash: string | null;
  options: Record<string, unknown>;
}

/**
 * Only asymmetric algorithms are listed. `none` and the HMAC family are absent
 * on purpose: accepting either lets anyone who has read the metadata mint a
 * token the gateway would believe.
 */
const ALGORITHMS: Record<string, AlgorithmSpec> = {
  RS256: { hash: "sha256", options: { padding: constants.RSA_PKCS1_PADDING } },
  RS384: { hash: "sha384", options: { padding: constants.RSA_PKCS1_PADDING } },
  RS512: { hash: "sha512", options: { padding: constants.RSA_PKCS1_PADDING } },
  PS256: {
    hash: "sha256",
    options: {
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
  },
  PS384: {
    hash: "sha384",
    options: {
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
  },
  PS512: {
    hash: "sha512",
    options: {
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
  },
  ES256: { hash: "sha256", options: { dsaEncoding: "ieee-p1363" } },
  ES384: { hash: "sha384", options: { dsaEncoding: "ieee-p1363" } },
  ES512: { hash: "sha512", options: { dsaEncoding: "ieee-p1363" } },
  EdDSA: { hash: null, options: {} },
};

interface DecodedJwt {
  header: JsonObject;
  claims: JsonObject;
  signingInput: string;
  signature: Buffer;
}

function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw invalidToken("Bearer credential is not a JSON Web Token");
  }
  const [rawHeader, rawClaims, rawSignature] = parts as [string, string, string];
  return {
    header: decodeSegment(rawHeader, "header"),
    claims: decodeSegment(rawClaims, "claims"),
    signingInput: `${rawHeader}.${rawClaims}`,
    signature: Buffer.from(rawSignature, "base64url"),
  };
}

function decodeSegment(segment: string, what: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed as JsonObject;
  } catch {
    throw invalidToken(`Token ${what} is not readable JSON`);
  }
}

function selectKey(keys: JsonObject[], kid: string | null, alg: string): JsonObject | null {
  const family = alg.startsWith("ES") ? "EC" : alg === "EdDSA" ? "OKP" : "RSA";
  const usable = keys.filter((key) => {
    if (key["use"] !== undefined && key["use"] !== "sig") return false;
    if (typeof key["alg"] === "string" && key["alg"] !== alg) return false;
    return key["kty"] === family;
  });
  if (kid !== null) return usable.find((key) => key["kid"] === kid) ?? null;
  // Without a key id there is only an unambiguous answer when one key fits.
  return usable.length === 1 ? (usable[0] as JsonObject) : null;
}

function toKeyObject(jwk: JsonObject): KeyObject {
  try {
    return createPublicKey({ key: jwk as never, format: "jwk" });
  } catch (error) {
    throw invalidToken(`Signing key is unusable: ${(error as Error).message}`);
  }
}

function verifySignature(
  alg: string,
  key: KeyObject,
  signingInput: string,
  signature: Buffer,
): boolean {
  const spec = ALGORITHMS[alg];
  if (!spec) return false;
  try {
    return verify(
      spec.hash,
      Buffer.from(signingInput, "utf8"),
      { key, ...spec.options },
      signature,
    );
  } catch {
    return false;
  }
}

function invalidToken(message: string): GatewayError {
  return new GatewayError("UNAUTHENTICATED", message, {
    data: { oauthError: "invalid_token" },
  });
}
