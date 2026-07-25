import {
  GatewayError,
  isRecord,
  newId,
  type AuthorizationServerMetadata,
  type Clock,
  type OAuthIssuerRecord,
  type ProtectedResourceMetadata,
  type WwwAuthenticateChallenge,
} from "@umg/core";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import {
  canonicalIssuer,
  canonicalizeUrl,
  issuerToWellKnown,
  parseAbsoluteUrl,
  resourceMetadataCandidates,
  sameIssuer,
  type SafeFetcher,
} from "@umg/security";
import type { GatewayStore } from "@umg/storage";

export interface DiscoveryDeps {
  fetcher: SafeFetcher;
  store: GatewayStore;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
  allowHttp: boolean;
  metadataTtlMs?: number;
}

export interface ProtectedResourceDiscovery {
  metadata: ProtectedResourceMetadata;
  metadataUrl: string;
}

export interface AuthorizationServerDiscovery {
  record: OAuthIssuerRecord;
  metadata: AuthorizationServerMetadata;
}

const DEFAULT_TTL_MS = 3_600_000;

export class OAuthDiscoveryService {
  constructor(private readonly deps: DiscoveryDeps) {}

  /**
   * Resolves RFC 9728 metadata for an MCP endpoint. The `resource_metadata`
   * parameter of the challenge wins when present; otherwise the well-known
   * locations derived from the endpoint path are tried in order.
   */
  async discoverProtectedResource(
    mcpUrl: string,
    challenge?: WwwAuthenticateChallenge,
  ): Promise<ProtectedResourceDiscovery> {
    const candidates: string[] = [];
    const advertised = challenge?.params["resource_metadata"];
    if (advertised) candidates.push(advertised);
    candidates.push(...resourceMetadataCandidates(mcpUrl));

    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const url = parseAbsoluteUrl(candidate);
        if (url.protocol === "http:" && !this.deps.allowHttp) {
          throw new GatewayError(
            "SSRF_BLOCKED",
            "Protected resource metadata must be served over HTTPS",
          );
        }
        const { value } = await this.deps.fetcher.getJson(candidate);
        const metadata = this.validateResourceMetadata(value, mcpUrl, candidate);
        return { metadata, metadataUrl: candidate };
      } catch (error) {
        failures.push(`${candidate}: ${(error as Error).message}`);
      }
    }
    throw new GatewayError(
      "DISCOVERY_FAILED",
      "Unable to load protected resource metadata",
      { data: { attempts: failures.slice(0, 4) } },
    );
  }

  private validateResourceMetadata(
    value: unknown,
    mcpUrl: string,
    metadataUrl: string,
  ): ProtectedResourceMetadata {
    if (!isRecord(value) || typeof value["resource"] !== "string") {
      throw new GatewayError(
        "DISCOVERY_FAILED",
        `Protected resource metadata at ${metadataUrl} has no resource field`,
      );
    }
    const metadata = value as unknown as ProtectedResourceMetadata;
    const policy = { allowHttp: this.deps.allowHttp };
    const declared = canonicalizeUrl(metadata.resource, policy);
    const requested = canonicalizeUrl(mcpUrl, policy);
    const isParent = requested === declared || requested.startsWith(`${declared}/`);
    if (!isParent) {
      this.deps.metrics.counter(Metric.ResourceMismatch, { stage: "prm" });
      throw new GatewayError(
        "RESOURCE_MISMATCH",
        "Protected resource metadata describes a different resource",
        { data: { declared, requested } },
      );
    }
    const servers = metadata.authorization_servers ?? [];
    if (servers.length === 0) {
      throw new GatewayError(
        "DISCOVERY_FAILED",
        "Protected resource metadata lists no authorization servers",
      );
    }
    return metadata;
  }

  /**
   * Fetches and caches RFC 8414 / OpenID Connect discovery metadata. The
   * issuer inside the document must equal the issuer that was requested, which
   * is what stops a compromised resource from redirecting the gateway to an
   * attacker controlled authorization server.
   */
  async discoverAuthorizationServer(
    issuer: string,
  ): Promise<AuthorizationServerDiscovery> {
    // Keyed on the canonical issuer, so the same server advertised by two
    // resources with and without a trailing slash resolves to one record and
    // keeps the id every connection and client registration points at.
    const cached = await this.deps.store.issuers.findByIssuer(canonicalIssuer(issuer));
    if (cached && cached.metadataExpiresAt > this.deps.clock.now()) {
      return { record: cached, metadata: cached.metadataJson as AuthorizationServerMetadata };
    }

    const url = parseAbsoluteUrl(issuer);
    if (url.protocol === "http:" && !this.deps.allowHttp) {
      throw new GatewayError(
        "SSRF_BLOCKED",
        "Authorization server issuers must use HTTPS",
      );
    }

    const candidates = [
      ...issuerToWellKnown(issuer, "oauth-authorization-server"),
      ...issuerToWellKnown(issuer, "openid-configuration"),
    ];
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const { value } = await this.deps.fetcher.getJson(candidate);
        const metadata = this.validateAuthorizationServerMetadata(value, issuer);
        const record = await this.cacheIssuer(metadata, cached);
        return { record, metadata };
      } catch (error) {
        failures.push(`${candidate}: ${(error as Error).message}`);
      }
    }
    throw new GatewayError(
      "DISCOVERY_FAILED",
      `Unable to load authorization server metadata for ${issuer}`,
      { data: { attempts: failures.slice(0, 4) } },
    );
  }

  private validateAuthorizationServerMetadata(
    value: unknown,
    issuer: string,
  ): AuthorizationServerMetadata {
    if (!isRecord(value) || typeof value["issuer"] !== "string") {
      throw new GatewayError("DISCOVERY_FAILED", "Metadata has no issuer field");
    }
    const metadata = value as unknown as AuthorizationServerMetadata;
    if (!sameIssuer(metadata.issuer, issuer)) {
      this.deps.metrics.counter(Metric.InvalidIssuer, { stage: "as_metadata" });
      throw new GatewayError(
        "ISSUER_MISMATCH",
        "Authorization server metadata issuer does not match the requested issuer",
        { data: { declared: metadata.issuer, requested: issuer } },
      );
    }
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new GatewayError(
        "DISCOVERY_FAILED",
        "Authorization server does not expose the endpoints required for the authorization code flow",
      );
    }
    // A discovery document the gateway will send codes, secrets and refresh
    // tokens to. An endpoint that is relative, uses another scheme, or drops
    // to plain HTTP is not something to find out about mid-flow.
    for (const field of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
      "introspection_endpoint",
      "jwks_uri",
      "pushed_authorization_request_endpoint",
    ] as const) {
      const endpoint = metadata[field];
      if (endpoint === undefined) continue;
      if (typeof endpoint !== "string") {
        throw new GatewayError("DISCOVERY_FAILED", `${field} is not a URL`);
      }
      const url = parseAbsoluteUrl(endpoint);
      if (url.protocol === "http:" && !this.deps.allowHttp) {
        throw new GatewayError(
          "DISCOVERY_FAILED",
          `${field} must be served over HTTPS`,
        );
      }
    }
    const methods = metadata.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) {
      throw new GatewayError(
        "DISCOVERY_FAILED",
        "Authorization server does not support PKCE S256",
      );
    }
    return metadata;
  }

  private async cacheIssuer(
    metadata: AuthorizationServerMetadata,
    existing: OAuthIssuerRecord | null,
  ): Promise<OAuthIssuerRecord> {
    const ttl = this.deps.metadataTtlMs ?? DEFAULT_TTL_MS;
    const record: OAuthIssuerRecord = {
      id: existing?.id ?? newId("iss"),
      issuer: canonicalIssuer(metadata.issuer),
      authorizationEndpoint: metadata.authorization_endpoint ?? null,
      tokenEndpoint: metadata.token_endpoint ?? null,
      registrationEndpoint: metadata.registration_endpoint ?? null,
      revocationEndpoint: metadata.revocation_endpoint ?? null,
      metadataJson: metadata as unknown as OAuthIssuerRecord["metadataJson"],
      metadataEtag: null,
      metadataExpiresAt: this.deps.clock.now() + ttl,
      supportsCimd: metadata.client_id_metadata_document_supported === true,
      supportsDcr: typeof metadata.registration_endpoint === "string",
      supportedAuthMethods: metadata.token_endpoint_auth_methods_supported ?? [
        "client_secret_basic",
      ],
      status: "ACTIVE",
    };
    return this.deps.store.issuers.upsert(record);
  }
}
