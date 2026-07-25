import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { GatewayError, systemClock, type AuthorizationServerMetadata } from "@umg/core";
import type { SafeFetcher, SafeRequestOptions, SafeResponse } from "@umg/security";

import { OAuthProtocolError, OAuthTokenClient } from "@umg/oauth";

const METADATA: AuthorizationServerMetadata = {
  issuer: "https://as.example.com",
  authorization_endpoint: "https://as.example.com/authorize",
  token_endpoint: "https://as.example.com/token",
  revocation_endpoint: "https://as.example.com/revoke",
};

interface Recorded {
  requests: SafeRequestOptions[];
}

/**
 * A fetcher that answers with whatever the test says and records what it was
 * asked. The token client's contract is the request it builds and the response
 * it accepts, so nothing more is needed to pin either down.
 */
function fetcherAnswering(
  reply: (request: SafeRequestOptions) => { status: number; body?: unknown },
): SafeFetcher & Recorded {
  const requests: SafeRequestOptions[] = [];
  const fetcher = {
    requests,
    async request(options: SafeRequestOptions): Promise<SafeResponse> {
      requests.push(options);
      const { status, body } = reply(options);
      const text = body === undefined ? "" : JSON.stringify(body);
      return {
        url: String(options.url),
        status,
        headers: {},
        contentType: "application/json",
        body: Readable.from([text]),
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
        discard: () => undefined,
      };
    },
  };
  return fetcher as unknown as SafeFetcher & Recorded;
}

function tokenResponse(): { status: number; body: unknown } {
  return {
    status: 200,
    body: { access_token: "at", token_type: "Bearer", expires_in: 3600 },
  };
}

describe("OAuthTokenClient client authentication", () => {
  it("form-encodes the credentials it puts in a Basic header", async () => {
    const fetcher = fetcherAnswering(() => tokenResponse());
    const client = new OAuthTokenClient(fetcher, systemClock);

    await client.refresh({
      metadata: METADATA,
      credentials: {
        clientId: "client one",
        clientSecret: "se+cr et/&?",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      refreshToken: "rt",
    });

    const header = fetcher.requests[0]?.headers?.["authorization"] ?? "";
    const decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString();

    // RFC 6749 section 2.3.1: application/x-www-form-urlencoded, so a space is
    // a plus rather than %20, and the reserved characters are escaped.
    expect(decoded).toBe("client+one:se%2Bcr+et%2F%26%3F");
  });

  it("refuses a method the server never said it accepts", async () => {
    const fetcher = fetcherAnswering(() => tokenResponse());
    const client = new OAuthTokenClient(fetcher, systemClock);

    const attempt = client.refresh({
      metadata: {
        ...METADATA,
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
      credentials: {
        clientId: "c",
        clientSecret: "s",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      refreshToken: "rt",
    });

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow(/does not accept client_secret_basic/u);
    expect(fetcher.requests).toHaveLength(0);
  });

  it("still tries when the server advertises nothing", async () => {
    const fetcher = fetcherAnswering(() => tokenResponse());
    const client = new OAuthTokenClient(fetcher, systemClock);

    await client.refresh({
      metadata: METADATA,
      credentials: {
        clientId: "c",
        clientSecret: "s",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      refreshToken: "rt",
    });

    expect(fetcher.requests).toHaveLength(1);
  });
});

describe("OAuthTokenClient revocation", () => {
  it("accepts the 200 RFC 7009 prescribes", async () => {
    const fetcher = fetcherAnswering(() => ({ status: 200 }));
    const client = new OAuthTokenClient(fetcher, systemClock);

    await expect(
      client.revoke({
        metadata: METADATA,
        credentials: { clientId: "c", tokenEndpointAuthMethod: "none" },
        token: "rt",
        tokenTypeHint: "refresh_token",
      }),
    ).resolves.toBeUndefined();
  });

  it("reports a refusal rather than claiming the token is gone", async () => {
    const fetcher = fetcherAnswering(() => ({
      status: 503,
      body: { error: "temporarily_unavailable" },
    }));
    const client = new OAuthTokenClient(fetcher, systemClock);

    const attempt = client.revoke({
      metadata: METADATA,
      credentials: { clientId: "c", tokenEndpointAuthMethod: "none" },
      token: "rt",
    });

    await expect(attempt).rejects.toBeInstanceOf(OAuthProtocolError);
    await expect(attempt).rejects.toThrow(/temporarily_unavailable/u);
  });

  it("does nothing when the server publishes no revocation endpoint", async () => {
    const fetcher = fetcherAnswering(() => ({ status: 500 }));
    const client = new OAuthTokenClient(fetcher, systemClock);

    const { revocation_endpoint: _omitted, ...withoutRevocation } = METADATA;
    await client.revoke({
      metadata: withoutRevocation,
      credentials: { clientId: "c", tokenEndpointAuthMethod: "none" },
      token: "rt",
    });

    expect(fetcher.requests).toHaveLength(0);
  });
});
