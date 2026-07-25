// A real MCP server built on the official SDK, so the gateway is talking to the
// reference implementation rather than to the mock in our conformance harness.
import { randomUUID } from "node:crypto";
import express from "express";
import * as jose from "jose";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 8811);
const NAME = process.env.NAME ?? "sdk-reference-server";
// When set, the server behaves like a protected resource: it refuses anything
// without this bearer token and advertises where to get one.
const REQUIRED_TOKEN = process.env.REQUIRED_TOKEN ?? "";
// When an issuer is configured the server stops accepting a shared secret and
// becomes a real resource server: every token is introspected at the provider,
// and the audience is checked so a token minted for somewhere else is refused.
const ISSUER = process.env.ISSUER ?? "";
const INTROSPECT_ID = process.env.INTROSPECT_ID ?? "resource-server";
const INTROSPECT_SECRET = process.env.INTROSPECT_SECRET ?? "resource-server-secret";
const RESOURCE_METADATA_URL =
  process.env.RESOURCE_METADATA_URL ??
  (ISSUER ? `http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource` : "");

function build() {
  const server = new McpServer(
    { name: NAME, version: "1.0.0" },
    { capabilities: { logging: {}, tools: {}, resources: {}, prompts: {} } },
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns whatever it is given",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
  );

  server.registerTool(
    "add",
    {
      title: "Add",
      description: "Adds two numbers",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );

  server.registerTool(
    "slow",
    {
      title: "Slow",
      description: "Reports progress then finishes",
      inputSchema: { steps: z.number().optional() },
    },
    async ({ steps = 3 }, extra) => {
      for (let i = 1; i <= steps; i += 1) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: extra._meta?.progressToken ?? "p", progress: i, total: steps },
        });
        await new Promise((r) => setTimeout(r, 50));
      }
      return { content: [{ type: "text", text: `done in ${steps} steps` }] };
    },
  );

  server.registerTool(
    "boom",
    { title: "Boom", description: "Always fails", inputSchema: {} },
    async () => {
      throw new Error("intentional upstream failure");
    },
  );

  server.registerResource(
    "readme",
    "file:///readme.txt",
    { title: "Readme", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "reference server readme" }] }),
  );

  server.registerPrompt(
    "greet",
    { title: "Greet", description: "Greets someone", argsSchema: { name: z.string() } },
    ({ name }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Say hello to ${name}` } }],
    }),
  );

  return server;
}

const app = express();
app.use(express.json());

const transports = new Map();

/** Verifies an RFC 9449 proof: signature, method, target and key binding. */
async function checkDpop(req, boundThumbprint, resourceUrl) {
  const proof = req.headers.dpop;
  if (!proof) return "no DPoP proof presented";
  try {
    const header = JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString());
    if (header.typ !== "dpop+jwt") return `unexpected typ ${header.typ}`;
    const key = await jose.importJWK(header.jwk, header.alg);
    const { payload } = await jose.jwtVerify(proof, key);
    const thumbprint = await jose.calculateJwkThumbprint(header.jwk);
    if (thumbprint !== boundThumbprint) return "proof key does not match cnf.jkt";
    if (payload.htm !== req.method) return `htm ${payload.htm} != ${req.method}`;
    if (payload.htu !== resourceUrl) return `htu ${payload.htu} != ${resourceUrl}`;
    return null;
  } catch (error) {
    return `proof did not verify: ${error.message}`;
  }
}

async function introspect(token) {
  const basic = Buffer.from(`${INTROSPECT_ID}:${INTROSPECT_SECRET}`).toString("base64");
  const response = await fetch(`${ISSUER}/token/introspection`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok) return { active: false };
  return response.json();
}

app.use(async (req, res, next) => {
  if (!REQUIRED_TOKEN && !ISSUER) return next();
  if (req.path === "/.well-known/oauth-protected-resource") return next();

  const auth = req.headers.authorization ?? "";
  const challenge = RESOURCE_METADATA_URL
    ? `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`
    : "Bearer";
  const scheme = auth.split(" ")[0] ?? "";
  const token = /^(Bearer|DPoP)$/i.test(scheme) ? auth.slice(scheme.length + 1) : "";

  process.stdout.write(
    `  auth: scheme=${scheme || "(none)"} token=${token ? `${token.slice(0, 12)}…` : "(none)"} dpop=${req.headers.dpop ? "yes" : "no"}\n`,
  );

  if (!token) {
    res.setHeader("WWW-Authenticate", challenge);
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  if (ISSUER) {
    try {
      const claims = await introspect(token);
      process.stdout.write(`  introspection: ${JSON.stringify(claims).slice(0, 300)}\n`);
      if (!claims.active) {
        res.setHeader("WWW-Authenticate", `${challenge}, error="invalid_token"`);
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      const audience = [claims.aud].flat().filter(Boolean);
      const expected = `http://127.0.0.1:${PORT}/mcp`;
      if (audience.length > 0 && !audience.includes(expected)) {
        res.status(403).json({ error: "invalid_token", detail: `aud=${audience.join(",")}` });
        return;
      }
      // A sender-constrained token is only usable by the holder of the key it
      // was bound to, so the proof has to match or the token is worthless.
      const bound = claims.cnf?.jkt;
      if (bound) {
        const problem = await checkDpop(req, bound, expected);
        if (problem) {
          res.setHeader("WWW-Authenticate", `DPoP error="invalid_token"`);
          res.status(401).json({ error: "invalid_token", detail: problem });
          process.stdout.write(`  DPoP rejected: ${problem}\n`);
          return;
        }
        process.stdout.write(`  DPoP proof verified against cnf.jkt\n`);
      }
      req.tokenClaims = claims;
      next();
      return;
    } catch (error) {
      res.status(500).json({ error: "introspection_failed", detail: String(error) });
      return;
    }
  }

  if (token === REQUIRED_TOKEN) return next();
  res.setHeader("WWW-Authenticate", challenge);
  res.status(401).json({ error: "invalid_token" });
});

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await build().connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `http://127.0.0.1:${PORT}/mcp`,
    authorization_servers: [ISSUER],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
  });
});

app.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`${NAME} on http://127.0.0.1:${PORT}/mcp\n`);
});
