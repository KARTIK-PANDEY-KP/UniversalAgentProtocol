import { afterEach, describe, expect, it } from "vitest";

import { GatewayFixture, MockMcpServer } from "@uap/conformance";

/**
 * The management page exists so that the browser steps of this system —
 * authorizing an upstream, above all — can be done in a browser. It is also
 * the one HTML surface the gateway serves, which makes it the one place where
 * a credential broker could be talked into rendering someone else's markup.
 */
describe("management UI", () => {
  const started: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const resource of started.splice(0)) await resource.stop();
  });

  async function newGateway(
    options: ConstructorParameters<typeof GatewayFixture>[0] = {},
  ): Promise<GatewayFixture> {
    const gateway = new GatewayFixture(options);
    await gateway.start();
    started.push(gateway);
    return gateway;
  }

  it("serves a page that carries no credential of its own", async () => {
    const gateway = await newGateway();
    const response = await fetch(`${gateway.baseUrl}/ui`);
    const body = await response.text();

    // Unauthenticated on purpose: there is nothing in the document to protect,
    // and requiring a bearer header to fetch it would make it unopenable by
    // the browser it exists for.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).not.toContain(gateway.apiKey);
  });

  it("sends the visitor from the root to the page", async () => {
    const gateway = await newGateway();
    const response = await fetch(`${gateway.baseUrl}/`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/ui");
  });

  it("permits its own inline script by nonce and nothing else", async () => {
    const gateway = await newGateway();
    const response = await fetch(`${gateway.baseUrl}/ui`);
    const policy = response.headers.get("content-security-policy") ?? "";
    const body = await response.text();

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");

    // A policy naming a nonce the document does not carry would block the page
    // altogether; one the document carries twice over would not be a nonce.
    const declared = /'nonce-([A-Za-z0-9_-]+)'/u.exec(policy)?.[1];
    expect(declared).toBeTruthy();
    const used = [...body.matchAll(/nonce="([^"]+)"/gu)].map(([, value]) => value);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set([declared]));

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gives every response a fresh nonce", async () => {
    const gateway = await newGateway();
    const [first, second] = await Promise.all([
      fetch(`${gateway.baseUrl}/ui`).then((r) => r.headers.get("content-security-policy")),
      fetch(`${gateway.baseUrl}/ui`).then((r) => r.headers.get("content-security-policy")),
    ]);
    expect(first).not.toBe(second);
  });

  it("never puts an upstream's name into the document", async () => {
    // A display name is chosen by the server on the other end, which is
    // precisely the party a credential broker should not let write markup. The
    // page defends against this by containing no data at all: it is the same
    // bytes whatever is stored, and the browser fills it in through
    // textContent. So the test is that the hostile string is absent.
    const hostile = '</script><img src=x onerror="alert(1)">';
    const upstream = new MockMcpServer({
      requireAuth: false,
      name: hostile,
      tools: [{ name: "ping" }],
    });
    await upstream.start();
    started.push(upstream);

    const gateway = await newGateway();
    const created = await gateway.createConnection(upstream.url, { alias: "up" });
    expect(created.display_name).toBe(hostile);

    const body = await fetch(`${gateway.baseUrl}/ui`).then((r) => r.text());
    expect(body).not.toContain("onerror");
    expect(body).not.toContain(hostile);
  });

  it("builds no markup from data, so there is nothing to inject into", async () => {
    // The guard behind the test above. `innerHTML` is the one call that would
    // turn a stored string into elements; keeping it out of the page is what
    // makes the property hold for names, aliases and upstream error messages
    // alike, rather than for the cases someone remembered.
    const gateway = await newGateway();
    const body = await fetch(`${gateway.baseUrl}/ui`).then((r) => r.text());
    expect(body).not.toContain("innerHTML");
    expect(body).not.toContain("outerHTML");
    expect(body).not.toContain("insertAdjacentHTML");
    expect(body).not.toContain("document.write");
  });

  it("can be switched off entirely", async () => {
    const gateway = await newGateway({ config: { uiEnabled: false } });
    expect((await fetch(`${gateway.baseUrl}/ui`)).status).toBe(404);
    expect((await fetch(`${gateway.baseUrl}/`, { redirect: "manual" })).status).toBe(404);
    // The control plane is unaffected; only the HTML goes away.
    expect((await fetch(`${gateway.baseUrl}/healthz`)).status).toBe(200);
  });
});
