#!/usr/bin/env node
/**
 * Runs the gateway behind an ngrok tunnel, with the public URL wired into
 * GATEWAY_BASE_URL before the gateway boots.
 *
 * The ordering is the whole point. `GATEWAY_BASE_URL` is not cosmetic: every
 * redirect_uri the gateway registers and the client ID metadata document URL
 * are derived from it, so it has to be the address the authorization server
 * will use — and that address does not exist until the tunnel is up. Starting
 * ngrok first and reading the URL out of it is what lets a gateway on a laptop
 * take part in flows that require a public HTTPS callback.
 *
 * Ctrl-C stops both. So does either process dying on its own.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PORT = process.env["PORT"] ?? "8787";
const DOMAIN = process.env["NGROK_DOMAIN"];
const START_TIMEOUT_MS = 30_000;

/**
 * ngrok's own log is the source for the URL rather than its API on port 4040,
 * because that port belongs to whichever agent started first and reading it
 * would silently attach us to someone else's tunnel.
 */
export function tunnelUrlFrom(line) {
  if (!line.includes("started tunnel")) return null;
  const json = line.trim().startsWith("{") ? safeJson(line) : null;
  if (json?.url) return String(json.url);
  return /url=(https:\/\/\S+)/u.exec(line)?.[1] ?? null;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * A tunnel puts a credential broker on the public internet, where the API key
 * is the only thing between a stranger and every OAuth grant it holds. A key
 * short enough to guess is not a key, and the default in the documentation is
 * `dev-key`, so this is worth stopping rather than mentioning.
 */
export function weakKeys(spec) {
  return (spec ?? "")
    .split(",")
    .map((entry) => entry.trim().split(":")[0] ?? "")
    .filter((key) => key.length > 0 && key.length < 24);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const weak = weakKeys(process.env["GATEWAY_API_KEYS"]);
if (weak.length > 0 && process.env["UAP_TUNNEL_ALLOW_WEAK_KEY"] !== "1") {
  fail(
    `Refusing to expose the gateway with a guessable API key (${weak.join(", ")}).\n` +
      "A tunnel makes this reachable by anyone, and the key is all that stands\n" +
      "between them and the OAuth grants it stores. Generate one:\n\n" +
      '  export GATEWAY_API_KEYS="uap_$(openssl rand -hex 24):tenant_local:user_local:local:admin"\n\n' +
      "Set UAP_TUNNEL_ALLOW_WEAK_KEY=1 to proceed anyway.",
  );
}

const children = [];
let shuttingDown = false;

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  // Give them a moment to close listeners and database handles.
  setTimeout(() => process.exit(code), 500).unref();
}

function watch(child, name) {
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`\n${name} exited (${signal ?? code}); stopping the rest.\n`);
    }
    stopAll(code ?? 0);
  });
  child.on("error", (error) => {
    fail(
      name === "ngrok" && error.code === "ENOENT"
        ? "ngrok is not installed or not on PATH. See https://ngrok.com/download,\n" +
            "or `brew install ngrok`, then `ngrok config add-authtoken <token>`."
        : `${name} could not start: ${error.message}`,
    );
  });
  return child;
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

const args = ["http", PORT, "--log", "stdout", "--log-format", "json"];
if (DOMAIN) args.push(`--domain=${DOMAIN}`);

const ngrok = watch(spawn("ngrok", args, { stdio: ["ignore", "pipe", "inherit"] }), "ngrok");

const publicUrl = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    fail(
      "ngrok did not report a tunnel within 30 seconds. Run `ngrok http " +
        `${PORT}\` on its own to see why; an unauthenticated agent is the usual cause.`,
    );
  }, START_TIMEOUT_MS);

  createInterface({ input: ngrok.stdout }).on("line", (line) => {
    const url = tunnelUrlFrom(line);
    if (!url) return;
    clearTimeout(timer);
    resolve(url);
  });
});

process.stdout.write(
  `\nTunnel   ${publicUrl}\n` +
    `Gateway  ${publicUrl}/ui\n` +
    (DOMAIN
      ? ""
      : "\nThis URL changes every run, and the OAuth clients registered against\n" +
        "the last one will not match the next. Reserve a domain on ngrok and set\n" +
        "NGROK_DOMAIN to keep your authorizations working across restarts.\n") +
    "\nAnyone with this URL can reach the gateway. Only the API key stops them.\n\n",
);

watch(
  spawn("node", ["apps/gateway-api/dist/main.js"], {
    stdio: "inherit",
    env: { ...process.env, GATEWAY_BASE_URL: publicUrl },
  }),
  "gateway",
);
