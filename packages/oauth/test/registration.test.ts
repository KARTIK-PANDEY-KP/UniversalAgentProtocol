import { describe, expect, it } from "vitest";

import type { AuthorizationServerMetadata } from "@umg/core";
import { createLogger, silentSink } from "@umg/observability";
import {
  ClientIdMetadataDocumentStrategy,
  assertValidClientIdMetadataUrl,
  buildClientIdMetadataDocument,
  gatewayIdentityFromBaseUrl,
  type RegistrationDeps,
} from "@umg/oauth";

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
function strategy(baseUrl: string, allowHttp: boolean): ClientIdMetadataDocumentStrategy {
  const deps = {
    identity: gatewayIdentityFromBaseUrl(baseUrl),
    logger: createLogger({ sink: silentSink }),
    allowHttp,
  } as unknown as RegistrationDeps;
  return new ClientIdMetadataDocumentStrategy(deps);
}

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
    expect(await strategy("https://gateway.example.com", false).supports(CIMD_SERVER)).toBe(
      true,
    );
  });

  it("stands aside for a plain HTTP deployment in production", async () => {
    // Left alone this would produce a registration the authorization server
    // rejects; standing aside lets dynamic registration take the connection.
    expect(await strategy("http://gateway.example.com", false).supports(CIMD_SERVER)).toBe(
      false,
    );
    expect(await strategy("http://127.0.0.1:8080", true).supports(CIMD_SERVER)).toBe(true);
  });

  it("stands aside when the server never advertised the mechanism", async () => {
    expect(
      await strategy("https://gateway.example.com", false).supports({
        ...CIMD_SERVER,
        client_id_metadata_document_supported: false,
      }),
    ).toBe(false);
  });
});
