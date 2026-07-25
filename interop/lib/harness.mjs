// The small amount of scaffolding every interop script needs: a client pointed
// at the running gateway, and a way to report a named check without a test
// runner in the picture.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { GATEWAY, GATEWAY_KEY } from "../rig.mjs";

const results = [];

export async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push(true);
    process.stdout.write(`PASS  ${name} — ${detail} [${Date.now() - started}ms]\n`);
  } catch (error) {
    results.push(false);
    process.stdout.write(`FAIL  ${name} — ${describe(error)}\n`);
  }
}

/**
 * A failure against a live server is usually explained by something two levels
 * down — a socket error under a fetch error under an SDK error — so the chain
 * is printed rather than just the outermost message.
 */
function describe(error) {
  const parts = [];
  for (let current = error; current; current = current.cause) {
    parts.push(`${current.code ?? ""} ${current.message ?? current}`.trim());
    if (parts.length >= 3) break;
  }
  return parts.join(" | ");
}

/** Exits non-zero if anything failed, so a shell can chain the suites. */
export function report() {
  const failures = results.filter((result) => !result).length;
  process.stdout.write(`\n${results.length - failures}/${results.length} passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

export async function connect(options = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${GATEWAY_KEY}` } },
  });
  const client = new Client(
    { name: options.name ?? "interop", version: "1.0.0" },
    { capabilities: options.capabilities ?? {} },
  );
  // Handlers go on before connecting, because the server may ask something the
  // moment the session opens.
  if (options.onNotification) {
    client.fallbackNotificationHandler = async (notification) => {
      options.onNotification(notification);
    };
  }
  options.configure?.(client);
  await client.connect(transport);
  return client;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
