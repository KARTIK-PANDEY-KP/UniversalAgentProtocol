// Brings the rig up and down. Every process is started detached with its pid
// and log recorded under .run/, so a test can kill and revive one server by
// name without a terminal multiplexer in the way.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATEWAY, GATEWAY_KEY, ISSUER, PROTECTED_URL } from "./lib/config.mjs";

export { GATEWAY, GATEWAY_KEY, ISSUER, PROTECTED_URL };

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
export const RUN_DIR = join(here, ".run");

/** Fixed, so a gateway restart can still read the vault it wrote. */
const ENCRYPTION_KEY = "k1:8mQO1Qb2rQ7yq0y0nTLc7HxJv5r5H1Zk2Jp0nQ0m4dE=";

/**
 * The provider sits behind a logging proxy so its issuer identity (8821) is
 * stable while the process itself listens elsewhere, and so every token and
 * registration request can be read back byte for byte when something fails.
 */
export const PROCESSES = {
  // The proxy comes first so the provider's readiness can be checked through
  // it, which proves the path the gateway will actually use.
  proxy: {
    cwd: here,
    command: ["node", "servers/proxy.mjs"],
    env: { LISTEN: "8821", TARGET_PORT: "8823" },
  },
  oidc: {
    cwd: here,
    command: ["node", "servers/oidc.mjs"],
    env: { PORT: "8823", ISSUER_URL: ISSUER, RESOURCE: PROTECTED_URL },
    ready: `${ISSUER}/.well-known/openid-configuration`,
  },
  ref: {
    cwd: here,
    command: ["node", "servers/mcp-server.mjs"],
    env: { PORT: "8811", NAME: "sdk-reference-server" },
  },
  secure: {
    cwd: here,
    command: ["node", "servers/mcp-server.mjs"],
    env: { PORT: "8812", NAME: "sdk-protected-server", ISSUER },
  },
  everything: {
    cwd: here,
    command: ["npx", "mcp-server-everything", "streamableHttp"],
    env: { PORT: "8813" },
  },
  gateway: {
    cwd: repo,
    command: ["node", "apps/gateway-api/dist/main.js"],
    env: {
      PORT: "8801",
      GATEWAY_BASE_URL: GATEWAY,
      GATEWAY_API_KEYS: `${GATEWAY_KEY}:t1:u1:laptop:admin`,
      GATEWAY_DATABASE_FILE: join(RUN_DIR, "gateway.db"),
      GATEWAY_ENCRYPTION_KEYS: ENCRYPTION_KEY,
    },
    ready: `${GATEWAY}/healthz`,
  },
};

/** The upstreams the gateway federates, in the order they are attached. */
export const UPSTREAMS = [
  { alias: "ref", url: "http://127.0.0.1:8811/mcp" },
  { alias: "everything", url: "http://127.0.0.1:8813/mcp" },
  { alias: "deepwiki", url: "https://mcp.deepwiki.com/mcp" },
  { alias: "gitmcp", url: "https://gitmcp.io/docs" },
  { alias: "context7", url: "https://mcp.context7.com/mcp" },
  { alias: "secure", url: PROTECTED_URL },
];

const pidFile = (name) => join(RUN_DIR, `${name}.pid`);
export const logFile = (name) => join(RUN_DIR, `${name}.log`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRunning(name) {
  if (!existsSync(pidFile(name))) return false;
  const pid = Number(readFileSync(pidFile(name), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function start(name) {
  const spec = PROCESSES[name];
  if (!spec) throw new Error(`No process named ${name}`);
  if (isRunning(name)) return;
  mkdirSync(RUN_DIR, { recursive: true });

  const out = openSync(logFile(name), "a");
  const [command, ...args] = spec.command;
  const child = spawn(command, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));

  if (spec.ready) await waitFor(spec.ready);
  else await sleep(700);
}

export async function stop(name) {
  if (!existsSync(pidFile(name))) return;
  const pid = Number(readFileSync(pidFile(name), "utf8"));
  try {
    // The group, because npx and the like leave the real server behind.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  rmSync(pidFile(name), { force: true });
  await sleep(500);
}

export async function restart(name) {
  await stop(name);
  await start(name);
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`${url} never became ready`);
}

export async function api(path, init = {}) {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, ...(init.headers ?? {}) },
  });
  return response.json();
}

async function attachAll() {
  for (const { alias, url } of UPSTREAMS) {
    const result = await api("/api/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_url: url, alias }),
    });
    process.stdout.write(
      `  ${alias.padEnd(12)} ${result.status ?? result.error} ${result.tool_count ?? 0} tools\n`,
    );
  }
}

async function authorizeProtected() {
  const { connections } = await api("/api/v1/connections");
  const secure = connections.find((connection) => connection.alias === "secure");
  if (!secure) throw new Error("the protected upstream was never attached");
  const { visit } = await import("./lib/browser.mjs");
  await visit(`${GATEWAY}/connect/${secure.connection_id}`, { verbose: false });
  const after = await api(`/api/v1/connections/${secure.connection_id}`);
  process.stdout.write(`  secure -> ${after.status} ${after.tool_count} tools\n`);
}

const commands = {
  async up() {
    // A clean database, so an attach is always a first attach.
    rmSync(join(RUN_DIR, "gateway.db"), { force: true });
    for (const name of Object.keys(PROCESSES)) {
      await stop(name);
      await start(name);
      process.stdout.write(`  started ${name}\n`);
    }
    process.stdout.write("attaching upstreams\n");
    await attachAll();
    process.stdout.write("authorizing the protected upstream\n");
    await authorizeProtected();
  },
  async down() {
    for (const name of Object.keys(PROCESSES).reverse()) {
      await stop(name);
      process.stdout.write(`  stopped ${name}\n`);
    }
  },
  async status() {
    for (const name of Object.keys(PROCESSES)) {
      process.stdout.write(`  ${name.padEnd(12)} ${isRunning(name) ? "up" : "down"}\n`);
    }
  },
  async restart() {
    const name = process.argv[3];
    if (!name) throw new Error("restart needs a process name");
    await restart(name);
    process.stdout.write(`  restarted ${name}\n`);
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2] ?? "status"];
  if (!command) {
    process.stderr.write(`Usage: node rig.mjs up|down|status|restart <name>\n`);
    process.exit(1);
  }
  await command();
}
