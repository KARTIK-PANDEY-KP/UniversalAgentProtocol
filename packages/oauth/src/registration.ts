import {
  GatewayError,
  isRecord,
  isTokenEndpointAuthMethod,
  newId,
  type AuthorizationServerMetadata,
  type Clock,
  type DynamicClientRegistrationResponse,
  type OAuthClientRegistrationRecord,
  type OAuthIssuerRecord,
  type RegistrationType,
  type TokenEndpointAuthMethod,
} from "@umg/core";
import { Metric, type Logger, type MetricsRegistry } from "@umg/observability";
import type { CredentialVault, SafeFetcher, SigningKeyStore } from "@umg/security";
import type { GatewayStore } from "@umg/storage";

import type { GatewayIdentity } from "./client-metadata.js";
import { OAuthProtocolError } from "./protocol-error.js";

export interface RegistrationContext {
  tenantId: string;
  issuerRecord: OAuthIssuerRecord;
  metadata: AuthorizationServerMetadata;
  redirectUri: string;
  requestedScopes: string[];
  /** Optional RFC 7591 initial access token supplied by an administrator. */
  initialAccessToken?: string | null;
}

export interface ResolvedClientRegistration {
  registrationId: string;
  registrationType: RegistrationType;
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

export interface OAuthClientRegistrationStrategy {
  readonly type: RegistrationType;
  supports(
    metadata: AuthorizationServerMetadata,
    context: RegistrationContext,
  ): Promise<boolean>;
  getOrCreateRegistration(
    context: RegistrationContext,
  ): Promise<ResolvedClientRegistration>;
}

export interface RegistrationDeps {
  store: GatewayStore;
  vault: CredentialVault;
  fetcher: SafeFetcher;
  identity: GatewayIdentity;
  signingKeys: SigningKeyStore;
  clock: Clock;
  logger: Logger;
  metrics: MetricsRegistry;
}

function pickAuthMethod(
  supported: string[] | undefined,
  preference: TokenEndpointAuthMethod[],
): TokenEndpointAuthMethod {
  const advertised = supported?.filter(isTokenEndpointAuthMethod) ?? [];
  if (advertised.length === 0) return preference[0] ?? "none";
  for (const candidate of preference) {
    if (advertised.includes(candidate)) return candidate;
  }
  return advertised[0] ?? "none";
}

async function toResolved(
  record: OAuthClientRegistrationRecord,
  deps: RegistrationDeps,
): Promise<ResolvedClientRegistration> {
  const clientSecret = await deps.vault.decryptOptional(
    { tenantId: record.tenantId, purpose: "client_secret" },
    record.encryptedClientSecret,
  );
  return {
    registrationId: record.id,
    registrationType: record.registrationType,
    clientId: record.clientId,
    clientSecret,
    tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
  };
}

/** Credentials an administrator created in the provider's developer portal. */
export class PreconfiguredRegistrationStrategy
  implements OAuthClientRegistrationStrategy
{
  readonly type: RegistrationType = "PRECONFIGURED";

  constructor(private readonly deps: RegistrationDeps) {}

  async supports(
    _metadata: AuthorizationServerMetadata,
    context: RegistrationContext,
  ): Promise<boolean> {
    const record = await this.deps.store.preconfiguredClients.findByIssuer(
      context.tenantId,
      context.issuerRecord.issuer,
    );
    return record !== null;
  }

  async getOrCreateRegistration(
    context: RegistrationContext,
  ): Promise<ResolvedClientRegistration> {
    const configured = await this.deps.store.preconfiguredClients.findByIssuer(
      context.tenantId,
      context.issuerRecord.issuer,
    );
    if (!configured) {
      throw new GatewayError(
        "CLIENT_CREDENTIALS_REQUIRED",
        "No preconfigured OAuth client for this authorization server",
      );
    }
    const existing = await this.findExisting(context, configured.clientId);
    if (existing) return toResolved(existing, this.deps);

    const record: OAuthClientRegistrationRecord = {
      id: newId("reg"),
      tenantId: context.tenantId,
      issuerId: context.issuerRecord.id,
      registrationType: "PRECONFIGURED",
      clientId: configured.clientId,
      encryptedClientSecret: configured.clientSecretEncrypted,
      tokenEndpointAuthMethod: configured.tokenEndpointAuthMethod,
      redirectUris: [configured.redirectUri],
      registrationAccessTokenEncrypted: null,
      registrationClientUri: null,
      issuedAt: this.deps.clock.now(),
      secretExpiresAt: null,
      metadataJson: {},
      status: "ACTIVE",
    };
    await this.deps.store.registrations.create(record);
    this.deps.metrics.counter(Metric.OauthPreregistered, {
      issuer: context.issuerRecord.issuer,
    });
    return toResolved(record, this.deps);
  }

  private async findExisting(
    context: RegistrationContext,
    clientId: string,
  ): Promise<OAuthClientRegistrationRecord | null> {
    const existing = await this.deps.store.registrations.findActive(
      context.tenantId,
      context.issuerRecord.id,
    );
    if (!existing) return null;
    if (existing.registrationType === "PRECONFIGURED" && existing.clientId !== clientId) {
      // The administrator replaced the credentials; retire the stale record.
      await this.deps.store.registrations.update(existing.id, { status: "INVALID" });
      return null;
    }
    return existing.registrationType === "PRECONFIGURED" ? existing : null;
  }
}

/** Identifies the gateway by the URL of its published metadata document. */
export class ClientIdMetadataDocumentStrategy
  implements OAuthClientRegistrationStrategy
{
  readonly type: RegistrationType = "CIMD";

  constructor(private readonly deps: RegistrationDeps) {}

  async supports(metadata: AuthorizationServerMetadata): Promise<boolean> {
    return metadata.client_id_metadata_document_supported === true;
  }

  async getOrCreateRegistration(
    context: RegistrationContext,
  ): Promise<ResolvedClientRegistration> {
    const existing = await this.deps.store.registrations.findActive(
      context.tenantId,
      context.issuerRecord.id,
    );
    if (existing?.registrationType === "CIMD") return toResolved(existing, this.deps);

    const method = this.deps.identity.supportsPrivateKeyJwt
      ? pickAuthMethod(context.metadata.token_endpoint_auth_methods_supported, [
          "private_key_jwt",
          "none",
        ])
      : "none";
    const record: OAuthClientRegistrationRecord = {
      id: newId("reg"),
      tenantId: context.tenantId,
      issuerId: context.issuerRecord.id,
      registrationType: "CIMD",
      clientId: this.deps.identity.clientMetadataUrl,
      encryptedClientSecret: null,
      tokenEndpointAuthMethod: method === "private_key_jwt" ? "private_key_jwt" : "none",
      redirectUris: [context.redirectUri],
      registrationAccessTokenEncrypted: null,
      registrationClientUri: null,
      issuedAt: this.deps.clock.now(),
      secretExpiresAt: null,
      metadataJson: { source: "client_id_metadata_document" },
      status: "ACTIVE",
    };
    await this.deps.store.registrations.create(record);
    this.deps.metrics.counter(Metric.OauthCimd, {
      issuer: context.issuerRecord.issuer,
    });
    return toResolved(record, this.deps);
  }
}

/** RFC 7591 dynamic registration, keyed by tenant and issuer. */
export class DynamicClientRegistrationStrategy
  implements OAuthClientRegistrationStrategy
{
  readonly type: RegistrationType = "DYNAMIC";

  constructor(private readonly deps: RegistrationDeps) {}

  async supports(metadata: AuthorizationServerMetadata): Promise<boolean> {
    return typeof metadata.registration_endpoint === "string";
  }

  async getOrCreateRegistration(
    context: RegistrationContext,
  ): Promise<ResolvedClientRegistration> {
    const existing = await this.deps.store.registrations.findActive(
      context.tenantId,
      context.issuerRecord.id,
    );
    if (existing?.registrationType === "DYNAMIC" && !this.isExpired(existing)) {
      return toResolved(existing, this.deps);
    }
    if (existing?.registrationType === "DYNAMIC") {
      await this.deps.store.registrations.update(existing.id, { status: "INVALID" });
    }
    return this.register(context);
  }

  /** Re-registers after the authorization server rejected the stored client. */
  async reregister(
    context: RegistrationContext,
    previousId: string,
  ): Promise<ResolvedClientRegistration> {
    await this.deps.store.registrations.update(previousId, { status: "INVALID" });
    return this.register(context);
  }

  private isExpired(record: OAuthClientRegistrationRecord): boolean {
    if (record.secretExpiresAt === null || record.secretExpiresAt === 0) return false;
    return record.secretExpiresAt <= this.deps.clock.now();
  }

  private async register(
    context: RegistrationContext,
  ): Promise<ResolvedClientRegistration> {
    const endpoint = context.metadata.registration_endpoint;
    if (!endpoint) {
      throw new GatewayError(
        "REGISTRATION_FAILED",
        "Authorization server does not expose a registration endpoint",
      );
    }
    const preference: TokenEndpointAuthMethod[] = this.deps.identity
      .supportsPrivateKeyJwt
      ? ["private_key_jwt", "client_secret_basic", "client_secret_post", "none"]
      : ["client_secret_basic", "client_secret_post", "none"];
    const requestedMethod = pickAuthMethod(
      context.metadata.token_endpoint_auth_methods_supported,
      preference,
    );

    const body: Record<string, unknown> = {
      client_name: this.deps.identity.clientName,
      client_uri: this.deps.identity.baseUrl,
      redirect_uris: [context.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: requestedMethod,
      application_type: "web",
      software_id: this.deps.identity.softwareId,
      software_version: this.deps.identity.softwareVersion,
    };
    if (context.requestedScopes.length > 0) {
      body["scope"] = context.requestedScopes.join(" ");
    }
    if (this.deps.identity.logoUri) body["logo_uri"] = this.deps.identity.logoUri;
    if (requestedMethod === "private_key_jwt") {
      body["jwks_uri"] = this.deps.identity.jwksUri;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (context.initialAccessToken) {
      headers["authorization"] = `Bearer ${context.initialAccessToken}`;
    }

    const response = await this.deps.fetcher.request({
      url: endpoint,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      followRedirects: false,
    });
    const text = await response.text();
    const payload = safeParse(text);
    if (response.status !== 200 && response.status !== 201) {
      throw OAuthProtocolError.fromBody(
        response.status,
        payload,
        "invalid_client_metadata",
      );
    }
    if (!isRecord(payload) || typeof payload["client_id"] !== "string") {
      throw new GatewayError(
        "REGISTRATION_FAILED",
        "Registration endpoint returned no client_id",
      );
    }
    const registration = payload as unknown as DynamicClientRegistrationResponse;
    const echoedMethod =
      registration.token_endpoint_auth_method &&
      isTokenEndpointAuthMethod(registration.token_endpoint_auth_method)
        ? registration.token_endpoint_auth_method
        : requestedMethod;
    const needsSecret =
      echoedMethod === "client_secret_basic" || echoedMethod === "client_secret_post";
    const grantedMethod: TokenEndpointAuthMethod =
      needsSecret && !registration.client_secret ? "none" : echoedMethod;

    const record: OAuthClientRegistrationRecord = {
      id: newId("reg"),
      tenantId: context.tenantId,
      issuerId: context.issuerRecord.id,
      registrationType: "DYNAMIC",
      clientId: registration.client_id,
      encryptedClientSecret: await this.deps.vault.encryptOptional(
        { tenantId: context.tenantId, purpose: "client_secret" },
        registration.client_secret ?? null,
      ),
      tokenEndpointAuthMethod: grantedMethod,
      redirectUris: [context.redirectUri],
      registrationAccessTokenEncrypted: await this.deps.vault.encryptOptional(
        { tenantId: context.tenantId, purpose: "registration_access_token" },
        registration.registration_access_token ?? null,
      ),
      registrationClientUri: registration.registration_client_uri ?? null,
      issuedAt: registration.client_id_issued_at
        ? registration.client_id_issued_at * 1000
        : this.deps.clock.now(),
      secretExpiresAt:
        typeof registration.client_secret_expires_at === "number" &&
        registration.client_secret_expires_at > 0
          ? registration.client_secret_expires_at * 1000
          : null,
      metadataJson: { requested_token_endpoint_auth_method: requestedMethod },
      status: "ACTIVE",
    };
    await this.deps.store.registrations.create(record);
    this.deps.metrics.counter(Metric.OauthDcr, { issuer: context.issuerRecord.issuer });
    this.deps.logger.info("Registered gateway as an OAuth client", {
      issuer: context.issuerRecord.issuer,
      registrationType: "DYNAMIC",
    });
    return toResolved(record, this.deps);
  }
}

/**
 * Terminal strategy. When no automatic mechanism is available the connection
 * is parked until an operator supplies generic client credentials through the
 * control plane; the gateway never guesses provider specific defaults.
 */
export class UserSuppliedRegistrationStrategy
  implements OAuthClientRegistrationStrategy
{
  readonly type: RegistrationType = "USER_SUPPLIED";

  constructor(private readonly deps: RegistrationDeps) {}

  async supports(): Promise<boolean> {
    return true;
  }

  async getOrCreateRegistration(
    context: RegistrationContext,
  ): Promise<ResolvedClientRegistration> {
    const existing = await this.deps.store.registrations.findActive(
      context.tenantId,
      context.issuerRecord.id,
    );
    if (existing?.registrationType === "USER_SUPPLIED") {
      return toResolved(existing, this.deps);
    }
    throw new GatewayError(
      "CLIENT_CREDENTIALS_REQUIRED",
      "This authorization server requires an OAuth client ID. Enter the client ID and optional client secret.",
      { data: { issuer: context.issuerRecord.issuer } },
    );
  }
}

/**
 * Applies the client registration priority from the MCP authorization
 * specification: existing credentials, then a metadata document, then dynamic
 * registration, then ask an operator.
 */
export class RegistrationSelector {
  private readonly strategies: OAuthClientRegistrationStrategy[];

  constructor(deps: RegistrationDeps) {
    this.strategies = [
      new PreconfiguredRegistrationStrategy(deps),
      new ClientIdMetadataDocumentStrategy(deps),
      new DynamicClientRegistrationStrategy(deps),
      new UserSuppliedRegistrationStrategy(deps),
    ];
  }

  async resolve(context: RegistrationContext): Promise<ResolvedClientRegistration> {
    for (const strategy of this.strategies) {
      if (await strategy.supports(context.metadata, context)) {
        return strategy.getOrCreateRegistration(context);
      }
    }
    throw new GatewayError(
      "CLIENT_CREDENTIALS_REQUIRED",
      "No usable OAuth client registration mechanism",
    );
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
