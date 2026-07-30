import { describe, expect, it } from "vitest";

import type { AuthorizationServerMetadata } from "@uap/core";
import { createLogger, silentSink } from "@uap/observability";
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
  });

  it("stands aside when the authorization server could not fetch the document", async () => {
    // The mechanism hands the server a URL and waits for it to be fetched, so
    // it needs the server to be able to reach us. Nothing on the internet can
    // reach a loopback address, and a gateway on a laptop is the ordinary
    // case: without this the authorization request is built, sent, and refused
    // with "invalid client_id", where standing aside registers dynamically and
    // connects.
    expect(await strategy("http://127.0.0.1:8080", true).supports(CIMD_SERVER)).toBe(false);
  });

  it("still offers itself to an authorization server that is equally local", async () => {
    // The test is whether that server can reach this address, not whether the
    // address is public. Two processes on one machine can reach each other,
    // which is what makes local development against a local server work.
    const local: AuthorizationServerMetadata = {
      ...CIMD_SERVER,
      issuer: "http://127.0.0.1:9100",
    };
    expect(await strategy("http://127.0.0.1:8080", true).supports(local)).toBe(true);
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
