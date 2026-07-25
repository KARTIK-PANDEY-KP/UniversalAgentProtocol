// What the gateway does with a credential over its whole life against a real
// authorization server: an access token that expires under it, a refresh token
// the provider rotates on every use, and a grant the user revokes.
//
// The provider issues 30 second access tokens, so this suite is slow by
// construction: it has to outlive them.
import { readFileSync } from "node:fs";

import { check, connect, report, sleep } from "../lib/harness.mjs";
import { GATEWAY, api, logFile } from "../rig.mjs";

const ISSUER = "http://127.0.0.1:8821";
const ACCESS_TOKEN_TTL_MS = 34_000;

const { connections } = await api("/api/v1/connections");
const secure = connections.find((connection) => connection.alias === "secure");
if (!secure) throw new Error("the protected connection is not attached");

/**
 * The protected server logs a prefix of every token it is shown, so the test
 * can tell a reused token from a freshly minted one without reaching into the
 * gateway's vault.
 */
function tokensSeen() {
  const log = readFileSync(logFile("secure"), "utf8");
  return new Set([...log.matchAll(/token=([A-Za-z0-9._~-]{10,})/g)].map((match) => match[1]));
}

let client = await connect({ name: "token-lifecycle" });

await check("a fresh grant calls the protected server", async () => {
  const out = await client.callTool({ name: "secure.add", arguments: { a: 1, b: 2 } });
  return `answered ${out.content?.[0]?.text?.trim()}`;
});

await check("an expired access token is renewed without the user", async () => {
  const before = tokensSeen();
  await sleep(ACCESS_TOKEN_TTL_MS);
  const out = await client.callTool({ name: "secure.add", arguments: { a: 20, b: 22 } });
  if (out.content?.[0]?.text?.trim() !== "42") throw new Error("the call did not answer");
  const fresh = [...tokensSeen()].filter((token) => !before.has(token));
  if (fresh.length === 0) throw new Error("the same token was presented after it expired");
  return `refreshed silently; the server saw ${fresh.length} new token(s)`;
});

await check("the rotated refresh token survives a second expiry", async () => {
  // The provider rotates the refresh token on every use, so a gateway that
  // stored the old one would work once and fail here.
  await sleep(ACCESS_TOKEN_TTL_MS);
  const out = await client.callTool({ name: "secure.add", arguments: { a: 30, b: 12 } });
  if (out.content?.[0]?.text?.trim() !== "42") throw new Error("the call did not answer");
  return "second refresh worked, so the rotation was stored";
});

await check("a grant revoked at the provider is reported as needing the user", async () => {
  const revoked = await fetch(`${ISSUER}/admin/revoke-all`, { method: "POST" }).then((response) =>
    response.json(),
  );
  if (revoked.destroyed === 0) throw new Error("nothing was revoked");

  // The resource server introspects, so the revocation bites on the very next
  // call rather than waiting for the access token to run out.
  const failure = await client
    .callTool({ name: "secure.add", arguments: { a: 1, b: 1 } })
    .then(() => null)
    .catch((error) => error);
  if (!failure) throw new Error("the call succeeded against a revoked grant");

  const connection = await api(`/api/v1/connections/${secure.connection_id}`);
  if (!/REAUTH_REQUIRED|AUTHORIZATION_REQUIRED/.test(connection.status)) {
    throw new Error(`status is ${connection.status}, which asks the operator for nothing`);
  }
  return `refused (${failure.code}) and the connection reads ${connection.status}`;
});

await check("the other upstreams are untouched by one revoked grant", async () => {
  const out = await client.callTool({ name: "ref.add", arguments: { a: 2, b: 3 } });
  if (out.content?.[0]?.text?.trim() !== "5") throw new Error("an unrelated upstream broke");
  return "an unauthenticated neighbour still answers";
});

await check("reauthorizing puts it back without touching anything else", async () => {
  const { visit } = await import("../lib/browser.mjs");
  await visit(`${GATEWAY}/connect/${secure.connection_id}`, { verbose: false });

  await client.close();
  client = await connect({ name: "token-lifecycle" });
  const out = await client.callTool({ name: "secure.add", arguments: { a: 40, b: 2 } });
  if (out.content?.[0]?.text?.trim() !== "42") throw new Error("still not working after reauth");
  const connection = await api(`/api/v1/connections/${secure.connection_id}`);
  return `back to ${connection.status} with ${connection.tool_count} tools`;
});

await client.close();
report();
