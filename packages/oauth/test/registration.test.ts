import { describe, expect, it } from "vitest";

import type {
  AuthorizationServerMetadata,
  OAuthClientRegistrationRecord,
} from "@uap/core";
import { MetricsRegistry, createLogger, silentSink } from "@uap/observability";
import { CredentialVault, LocalKeyring } from "@uap/security";
import { createInMemoryStore } from "@uap/storage";
import {
  ClientIdMetadataDocumentStrategy,
  assertValidClientIdMetadataUrl,
  buildClientIdMetadataDocument,
  gatewayIdentityFromBaseUrl,
  type RegistrationDeps,
} from "@uap/oauth";

const CIMD_SERVER: AuthorizationServerMetadata = {
  issuer: "https://as.example.com",
  authorization_endpoint: "https://as.example.com/authorize",
  token_endpoint: "https://as.example.com/token",
  client_id_metadata_document_supported: true,
};

/**
 * `supports` reads only the gateway's own identity and its logger, so the rest
 * of the registration dependencies are left out rather than faked into
 * something that pretends to work.
 */
function strategy(
  baseUrl: string,
  allowHttp: boolean,
  past: Partial<OAuthClientRegistrationRecord>[] = [],
): ClientIdMetadataDocumentStrategy {
  const deps = {
    identity: gatewayIdentityFromBaseUrl(baseUrl),
    logger: createLogger({ sink: silentSink }),
    store: { registrations: { list: async () => past } },
    allowHttp,
  } as unknown as RegistrationDeps;
  return new ClientIdMetadataDocumentStrategy(deps);
}

/** `supports` reads the tenant and issuer only to look up past attempts. */
const CONTEXT = {
  tenantId: "tenant_a",
  issuerRecord: { id: "iss_1" },
  redirectUri: "https://gateway.example.com/oauth/callback",
  requestedScopes: [],
} as unknown as Parameters<ClientIdMetadataDocumentStrategy["supports"]>[1];

describe("client ID metadata documents", () => {
  it("accepts a document whose client_id is its own URL", () => {
    const identity = gatewayIdentityFromBaseUrl("https://gateway.example.com");
    expect(() =>
      assertValidClientIdMetadataUrl(
        identity.clientMetadataUrl,
        buildClientIdMetadataDocument(identity),
      ),
    ).not.toThrow();
  });

  it("refuses a document whose client_id names a different URL", () => {
    const identity = gatewayIdentityFromBaseUrl("https://gateway.example.com");
    const document = buildClientIdMetadataDocument(identity);
    document.client_id = "https://gateway.example.com/oauth/other.json";
    expect(() =>
      assertValidClientIdMetadataUrl(identity.clientMetadataUrl, document),
    ).toThrow(/must equal the document URL/);
  });

  it("refuses a metadata URL with no path", () => {
    const identity = gatewayIdentityFromBaseUrl("https://gateway.example.com");
    expect(() =>
      assertValidClientIdMetadataUrl("https://gateway.example.com/", {
        ...buildClientIdMetadataDocument(identity),
        client_id: "https://gateway.example.com/",
      }),
    ).toThrow(/must contain a path/);
  });

  it("offers itself when the deployment can publish a valid document", async () => {
    expect(await strategy("https://gateway.example.com", false).supports(CIMD_SERVER, CONTEXT)).toBe(
      true,
    );
  });

  it("stands aside for a plain HTTP deployment in production", async () => {
    // Left alone this would produce a registration the authorization server
    // rejects; standing aside lets dynamic registration take the connection.
    expect(await strategy("http://gateway.example.com", false).supports(CIMD_SERVER, CONTEXT)).toBe(
      false,
    );
  });

  it("stands aside when the authorization server could not fetch the document", async () => {
    // The mechanism hands the server a URL and waits for it to be fetched, so
    // it needs the server to be able to reach us. Nothing on the internet can
    // reach a loopback address, and a gateway on a laptop is the ordinary
    // case: without this the authorization request is built, sent, and refused
    // with "invalid client_id", where standing aside registers dynamically and
    // connects.
    expect(await strategy("http://127.0.0.1:8080", true).supports(CIMD_SERVER, CONTEXT)).toBe(false);
  });

  it("still offers itself to an authorization server that is equally local", async () => {
    // The test is whether that server can reach this address, not whether the
    // address is public. Two processes on one machine can reach each other,
    // which is what makes local development against a local server work.
    const local: AuthorizationServerMetadata = {
      ...CIMD_SERVER,
      issuer: "http://127.0.0.1:9100",
    };
    expect(await strategy("http://127.0.0.1:8080", true).supports(local, CONTEXT)).toBe(true);
  });

  it("re-registers when the gateway has moved since it last registered", async () => {
    // A registration says where the client lives: the redirect URI it returns
    // to, and for CIMD the URL of the document describing it. Put the gateway
    // behind a tunnel and both statements are about the old address, so the
    // authorization server refuses a client_id it cannot fetch — while the
    // redirect_uri in the same request is the new one, which is what makes the
    // error so confusing. Reusing a registration made by a different address
    // is what has to stop.
    const store = await createInMemoryStore();
    const issuer = await store.issuers.upsert({
      id: "iss_1",
      issuer: "https://as.example.com",
      authorizationEndpoint: "https://as.example.com/authorize",
      tokenEndpoint: "https://as.example.com/token",
      registrationEndpoint: null,
      revocationEndpoint: null,
      metadataJson: {},
      metadataEtag: null,
      metadataExpiresAt: Date.now() + 60_000,
      supportsCimd: true,
      supportsDcr: false,
      supportedAuthMethods: ["none"],
      status: "ACTIVE",
    });

    const before = "http://127.0.0.1:8787";
    const after = "https://53f2.ngrok-free.app";
    const deps = (baseUrl: string): RegistrationDeps =>
      ({
        store,
        vault: new CredentialVault(LocalKeyring.generate()),
        identity: gatewayIdentityFromBaseUrl(baseUrl),
        clock: { now: () => Date.now() },
        logger: createLogger({ sink: silentSink }),
        metrics: new MetricsRegistry(),
        allowHttp: true,
      }) as unknown as RegistrationDeps;

    const context = (baseUrl: string): Parameters<
      ClientIdMetadataDocumentStrategy["getOrCreateRegistration"]
    >[0] => ({
      tenantId: "tenant_a",
      issuerRecord: issuer,
      metadata: CIMD_SERVER,
      redirectUri: `${baseUrl}/oauth/callback`,
      requestedScopes: [],
    });

    const first = await new ClientIdMetadataDocumentStrategy(
      deps(before),
    ).getOrCreateRegistration(context(before));
    expect(first.clientId).toBe(`${before}/oauth/client-metadata.json`);

    const second = await new ClientIdMetadataDocumentStrategy(
      deps(after),
    ).getOrCreateRegistration(context(after));
    expect(second.clientId).toBe(`${after}/oauth/client-metadata.json`);

    // Registering afresh is only half of it: the old row has to stop being
    // active, or the next lookup finds it again.
    expect(await store.registrations.findActive("tenant_a", issuer.id)).toMatchObject({
      clientId: `${after}/oauth/client-metadata.json`,
    });
    await store.close();
  });

  it("stands aside when the server never advertised the mechanism", async () => {
    expect(
      await strategy("https://gateway.example.com", false).supports({
        ...CIMD_SERVER,
        client_id_metadata_document_supported: false,
      }, CONTEXT),
    ).toBe(false);
  });
});
