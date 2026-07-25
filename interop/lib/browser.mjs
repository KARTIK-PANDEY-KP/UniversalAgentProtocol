// Stands in for the user's browser: follows the redirect chain from the
// gateway's connect URL through the provider's login and consent and back to
// the gateway callback. Cookies are kept per host, and the gateway API key is
// sent only to the gateway, the way a browser session would behave.
import { fileURLToPath } from "node:url";

import { GATEWAY, GATEWAY_KEY } from "./config.mjs";

const jar = new Map();

function cookieHeader(url) {
  const host = new URL(url).host;
  const cookies = jar.get(host);
  if (!cookies || cookies.size === 0) return null;
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(url, response) {
  const host = new URL(url).host;
  const raw = response.headers.getSetCookie?.() ?? [];
  if (raw.length === 0) return;
  const cookies = jar.get(host) ?? new Map();
  for (const line of raw) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  jar.set(host, cookies);
}

export async function visit(startUrl, { maxHops = 15, verbose = true } = {}) {
  const trail = [];
  let current = startUrl;

  for (let hop = 0; hop < maxHops; hop += 1) {
    trail.push(current);
    const headers = {};
    if (current.startsWith(GATEWAY)) headers.authorization = `Bearer ${GATEWAY_KEY}`;
    const cookies = cookieHeader(current);
    if (cookies) headers.cookie = cookies;

    const response = await fetch(current, { redirect: "manual", headers });
    storeCookies(current, response);
    const location = response.headers.get("location");
    if (verbose) {
      process.stdout.write(`  ${response.status} ${new URL(current).pathname}${location ? ` -> ${location.slice(0, 90)}` : ""}\n`);
    }
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { status: response.status, url: current, body: await response.text(), trail };
  }
  throw new Error(`too many redirects, trail:\n${trail.join("\n")}`);
}

// Only when run directly. Imported, argv belongs to whoever imported us.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const outcome = await visit(process.argv[2]);
  process.stdout.write(`\nfinal ${outcome.status} ${outcome.url}\n${outcome.body.slice(0, 400)}\n`);
}
