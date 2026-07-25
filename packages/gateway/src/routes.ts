import type { IncomingMessage, ServerResponse } from "node:http";

import { isTokenEndpointAuthMethod, newId, toGatewayError } from "@umg/core";
import { readBody, sendEmpty, sendJson, type NorthboundPrincipal } from "@umg/mcp-server";
import {
  buildClientIdMetadataDocument,
  type OAuthCallbackInput,
} from "@umg/oauth";
import { canonicalizeUrl } from "@umg/security";

import { parseJsonBody, type GatewayServices } from "./gateway.js";
import type { Router } from "./router.js";

type Authenticate = (req: IncomingMessage) => Promise<NorthboundPrincipal | null>;

const MAX_BODY = 1_000_000;

export function registerRoutes(
  router: Router,
  services: GatewayServices,
  authenticate: Authenticate,
): void {
  const { config, identity, signingKeys, connections, store, tokenManager } = services;
  const urlPolicy = { allowHttp: config.allowHttp };

  const requirePrincipal = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<NorthboundPrincipal | null> => {
    const principal = await authenticate(req);
    if (!principal) {
      sendJson(
        res,
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`,
        },
      );
      return null;
    }
    return principal;
  };

  router.get("/healthz", (_req, res) => {
    sendJson(res, 200, { status: "ok", version: "0.1.0" });
  });

  router.get("/metrics", (_req, res) => {
    const body = services.metrics.render();
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(body);
  });

  // The gateway is itself an OAuth protected resource so that downstream
  // clients can discover how to authenticate against it.
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    sendJson(
      res,
      200,
      {
        resource: `${config.baseUrl}/mcp`,
        authorization_servers: config.gatewayAuthorizationServers,
        scopes_supported: config.gatewayScopesSupported,
        bearer_methods_supported: ["header"],
        resource_name: "Universal MCP Gateway",
        resource_documentation: `${config.baseUrl}/docs`,
      },
      { "cache-control": "public, max-age=3600" },
    );
  });

  // The gateway's own OAuth client identity. The document URL is the client_id.
  router.get("/oauth/client-metadata.json", (_req, res) => {
    sendJson(res, 200, buildClientIdMetadataDocument(identity), {
      "cache-control": "public, max-age=3600",
    });
  });

  router.get("/.well-known/jwks.json", (_req, res) => {
    sendJson(res, 200, signingKeys.jwks(), { "cache-control": "public, max-age=300" });
  });

  router.all("/mcp", async (req, res) => {
    await services.northbound.handle(req, res);
  });

  /**
   * Completes an upstream authorization. The transaction carries every binding
   * that matters (state, PKCE, issuer, resource, connection), so the callback
   * itself needs no session cookie to be safe against forgery.
   */
  router.get("/oauth/callback", async (req, res, match) => {
    const input: OAuthCallbackInput = {};
    const code = match.query.get("code");
    const state = match.query.get("state");
    const iss = match.query.get("iss");
    const error = match.query.get("error");
    const description = match.query.get("error_description");
    if (code) input.code = code;
    if (state) input.state = state;
    if (iss) input.iss = iss;
    if (error) input.error = error;
    if (description) input.errorDescription = description;

    const principal = await authenticate(req);
    if (principal) input.actingUserId = principal.userId;

    try {
      const result = await tokenManager.exchangeCode(input);
      await connections
        .activateConnection(result.tenantId, result.connectionId)
        .catch(() => undefined);
      if (result.returnTo) {
        res.writeHead(302, { location: result.returnTo });
        res.end();
        return;
      }
      sendHtml(
        res,
        200,
        "Connection authorized",
        "You can close this window and return to your MCP client.",
      );
    } catch (cause) {
      const gatewayError = toGatewayError(cause);
      sendHtml(
        res,
        gatewayError.httpStatus,
        "Authorization failed",
        gatewayError.message,
      );
    }
  });

  /** Human entry point used by reconnect links surfaced in MCP errors. */
  router.get("/connect/:id", async (req, res, match) => {
    const principal = await authenticate(req);
    if (!principal) {
      sendHtml(
        res,
        401,
        "Sign in required",
        "Open this link from the gateway control plane, or call " +
          "POST /api/v1/connections/{id}/authorize with your gateway credentials.",
      );
      return;
    }
    const { authorizationUrl } = await connections.startAuthorization({
      tenantId: principal.tenantId,
      userId: principal.userId,
      connectionId: match.params["id"] ?? "",
    });
    res.writeHead(302, { location: authorizationUrl });
    res.end();
  });

  router.post("/api/v1/connections", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = parseJsonBody(await readBody(req, MAX_BODY));
    const mcpUrl = String(body["mcp_url"] ?? "");
    if (!mcpUrl) {
      sendJson(res, 400, { error: "invalid_request", message: "mcp_url is required" });
      return;
    }
    const view = await connections.createConnection({
      tenantId: principal.tenantId,
      userId: principal.userId,
      mcpUrl,
      ...(typeof body["alias"] === "string" ? { alias: body["alias"] } : {}),
      ...(body["owner_type"] === "WORKSPACE" ? { ownerType: "WORKSPACE" as const } : {}),
      ...(isStringRecord(body["headers"])
        ? { staticHeaders: body["headers"] }
        : {}),
    });
    sendJson(res, 201, toConnectionPayload(view, config.baseUrl));
  });

  router.get("/api/v1/connections", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const views = await connections.listConnections(
      principal.tenantId,
      principal.userId,
    );
    sendJson(res, 200, {
      connections: views.map((view) => toConnectionPayload(view, config.baseUrl)),
    });
  });

  router.get("/api/v1/connections/:id", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const view = await connections.getConnection(
      principal.tenantId,
      match.params["id"] ?? "",
    );
    sendJson(res, 200, toConnectionPayload(view, config.baseUrl));
  });

  router.post("/api/v1/connections/:id/authorize", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = await readOptionalBody(req);
    const result = await connections.startAuthorization({
      tenantId: principal.tenantId,
      userId: principal.userId,
      connectionId: match.params["id"] ?? "",
      returnTo: typeof body["return_to"] === "string" ? body["return_to"] : null,
    });
    sendJson(res, 200, { authorization_url: result.authorizationUrl });
  });

  router.post("/api/v1/connections/:id/reconnect", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const result = await connections.startAuthorization({
      tenantId: principal.tenantId,
      userId: principal.userId,
      connectionId: match.params["id"] ?? "",
    });
    sendJson(res, 200, { authorization_url: result.authorizationUrl });
  });

  router.post("/api/v1/connections/:id/refresh", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const sync = await connections.activateConnection(
      principal.tenantId,
      match.params["id"] ?? "",
    );
    sendJson(res, 200, {
      added: sync.added,
      removed: sync.removed,
      changed: sync.changed,
      unchanged: sync.unchanged.length,
    });
  });

  router.post("/api/v1/connections/:id/alias", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = parseJsonBody(await readBody(req, MAX_BODY));
    const view = await connections.rename(
      principal.tenantId,
      match.params["id"] ?? "",
      String(body["alias"] ?? ""),
    );
    sendJson(res, 200, toConnectionPayload(view, config.baseUrl));
  });

  router.delete("/api/v1/connections/:id", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    await connections.disconnect(principal.tenantId, match.params["id"] ?? "");
    sendEmpty(res, 204);
  });

  router.get("/api/v1/tools", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const tools = await store.tools.listByTenant(principal.tenantId);
    sendJson(res, 200, {
      tools: tools.map((tool) => ({
        id: tool.id,
        name: tool.gatewayName,
        upstream_name: tool.upstreamName,
        connection_id: tool.connectionId,
        enabled: tool.enabled,
        risk_level: tool.riskLevel,
        schema_hash: tool.schemaHash,
      })),
    });
  });

  router.post("/api/v1/tools/:id", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = parseJsonBody(await readBody(req, MAX_BODY));
    await connections.setToolEnabled(
      principal.tenantId,
      match.params["id"] ?? "",
      body["enabled"] === true,
    );
    sendJson(res, 200, { ok: true });
  });

  /**
   * Generic OAuth client configuration for authorization servers that require
   * a client created through a developer portal. This is configuration, not a
   * provider integration: the same code path consumes it for every issuer.
   */
  router.post("/api/v1/oauth-client-configurations", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = parseJsonBody(await readBody(req, MAX_BODY));
    const issuer = String(body["issuer"] ?? "");
    const clientId = String(body["client_id"] ?? "");
    const method = String(body["token_endpoint_auth_method"] ?? "client_secret_basic");
    if (!issuer || !clientId || !isTokenEndpointAuthMethod(method)) {
      sendJson(res, 400, {
        error: "invalid_request",
        message: "issuer, client_id and a supported token_endpoint_auth_method are required",
      });
      return;
    }
    const secret = body["client_secret"];
    const record = await store.preconfiguredClients.upsert({
      id: newId("pcc"),
      tenantId: principal.tenantId,
      issuer,
      clientId,
      clientSecretEncrypted:
        typeof secret === "string"
          ? await services.vault.encrypt(
              { tenantId: principal.tenantId, purpose: "client_secret" },
              secret,
            )
          : null,
      redirectUri: String(body["redirect_uri"] ?? identity.redirectUri),
      tokenEndpointAuthMethod: method,
      scopes: Array.isArray(body["scopes"]) ? (body["scopes"] as string[]) : null,
      createdAt: services.clock.now(),
    });
    sendJson(res, 201, { id: record.id, issuer: record.issuer });
  });

  /** Bulk import used by the migration CLI. */
  router.post("/api/v1/import", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = parseJsonBody(await readBody(req, MAX_BODY));
    const urls = Array.isArray(body["urls"]) ? (body["urls"] as unknown[]) : [];
    const results: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const entry of urls) {
      const rawUrl = typeof entry === "string" ? entry : String((entry as { url?: string })?.url ?? "");
      if (!rawUrl) continue;
      let canonical: string;
      try {
        canonical = canonicalizeUrl(rawUrl, urlPolicy);
      } catch (error) {
        results.push({ url: rawUrl, status: "INVALID", message: (error as Error).message });
        continue;
      }
      if (seen.has(canonical)) {
        results.push({ url: rawUrl, status: "DUPLICATE" });
        continue;
      }
      seen.add(canonical);
      try {
        const view = await connections.createConnection({
          tenantId: principal.tenantId,
          userId: principal.userId,
          mcpUrl: canonical,
        });
        results.push({
          url: canonical,
          status: view.status,
          connection_id: view.connectionId,
          alias: view.alias,
          authorize_url: `${config.baseUrl}/api/v1/connections/${view.connectionId}/authorize`,
        });
      } catch (error) {
        const gatewayError = toGatewayError(error);
        results.push({
          url: canonical,
          status: "FAILED",
          code: gatewayError.code,
          message: gatewayError.message,
        });
      }
    }
    sendJson(res, 200, { imported: results });
  });

  router.get("/api/v1/audit", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const events = await store.audit.list(principal.tenantId, 100);
    sendJson(res, 200, { events });
  });
}

function toConnectionPayload(
  view: {
    connectionId: string;
    alias: string;
    status: string;
    mcpUrl: string;
    displayName: string;
    toolCount: number;
    lastError: string | null;
    authorizationUrl?: string;
  },
  baseUrl: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    connection_id: view.connectionId,
    alias: view.alias,
    status: view.status,
    mcp_url: view.mcpUrl,
    display_name: view.displayName,
    tool_count: view.toolCount,
    last_error: view.lastError,
  };
  if (view.authorizationUrl) payload["authorization_url"] = view.authorizationUrl;
  if (view.status === "AUTHORIZATION_REQUIRED" || view.status === "REAUTH_REQUIRED") {
    payload["connect_url"] = `${baseUrl}/connect/${view.connectionId}`;
  }
  return payload;
}

async function readOptionalBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_BODY);
  if (raw.trim() === "") return {};
  return parseJsonBody(raw);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function sendHtml(
  res: ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:36rem;line-height:1.5;color:#111}h1{font-size:1.4rem}</style></head><body><h1>${escapeHtml(
    title,
  )}</h1><p>${escapeHtml(message)}</p></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
