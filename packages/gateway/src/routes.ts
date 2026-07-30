import type { IncomingMessage, ServerResponse } from "node:http";

import {
  isRecord,
  isTokenEndpointAuthMethod,
  newId,
  toGatewayError,
  type GatewayError,
} from "@uap/core";
import {
  bearerChallengeHeader,
  readBody,
  sendEmpty,
  sendJson,
  type AuthenticationOutcome,
  type NorthboundPrincipal,
} from "@uap/mcp-server";
import {
  buildClientIdMetadataDocument,
  type OAuthCallbackInput,
} from "@uap/oauth";
import { canonicalizeUrl, isReturnUrlAllowed } from "@uap/security";

import { parseJsonBody, type GatewayServices } from "./gateway.js";
import type { Router } from "./router.js";

type Authenticate = (req: IncomingMessage) => Promise<AuthenticationOutcome>;

const MAX_BODY = 1_000_000;

export function registerRoutes(
  router: Router,
  services: GatewayServices,
  authenticate: Authenticate,
): void {
  const { config, identity, signingKeys, connections, store, tokenManager } = services;
  const urlPolicy = { allowHttp: config.allowHttp };
  const returnToOrigins = [new URL(config.baseUrl).origin, ...config.returnToOrigins];

  const resourceMetadataUrl = `${config.baseUrl}/.well-known/oauth-protected-resource`;

  const requirePrincipal = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<NorthboundPrincipal | null> => {
    const outcome = await authenticate(req);
    if (!outcome.authenticated) {
      const { challenge } = outcome;
      sendJson(
        res,
        challenge?.status ?? 401,
        {
          error: challenge?.error ?? "unauthorized",
          ...(challenge ? { error_description: challenge.description } : {}),
        },
        {
          "www-authenticate": bearerChallengeHeader(resourceMetadataUrl, challenge),
        },
      );
      return null;
    }
    const principal = outcome.principal;
    const decision = services.apiLimiter.check(principal.tenantId);
    if (!decision.allowed) {
      sendJson(
        res,
        429,
        { error: "rate_limited", retry_after_seconds: decision.retryAfterSeconds },
        { "retry-after": String(decision.retryAfterSeconds) },
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
        resource_name: "Universal Agent Protocol Gateway",
        ...(config.documentationUri === null
          ? {}
          : { resource_documentation: config.documentationUri }),
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

    const outcome = await authenticate(req);
    if (outcome.authenticated) input.actingUserId = outcome.principal.userId;

    try {
      const result = await tokenManager.exchangeCode(input);
      // The grant is good even if discovery is not, but saying "authorized"
      // over a catalogue that never synced sends the user away believing the
      // job is done.
      const activation = await connections
        .activateConnection(result.tenantId, result.connectionId)
        .then(() => null)
        .catch((error: unknown) => toGatewayError(error));

      if (result.returnTo && isReturnUrlAllowed(result.returnTo, returnToOrigins)) {
        res.writeHead(302, { location: result.returnTo });
        res.end();
        return;
      }
      if (activation) {
        sendHtml(
          res,
          200,
          "Connection authorized, but its tools are not available yet",
          `The credentials were stored. Discovering what this server offers failed: ${activation.message}`,
        );
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
      // The gateway had to swap the client mid-flow, which orphans the code the
      // server just issued. Sending the user straight back through is the
      // difference between one extra hop and a connection they cannot finish.
      const retryId = replacedClientConnectionId(gatewayError);
      if (retryId) {
        res.writeHead(302, { location: `${config.baseUrl}/connect/${retryId}` });
        res.end();
        return;
      }
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
    const outcome = await authenticate(req);
    if (!outcome.authenticated) {
      sendHtml(
        res,
        401,
        "Sign in required",
        "Open this link from the gateway control plane, or call " +
          "POST /api/v1/connections/{id}/authorize with your gateway credentials.",
      );
      return;
    }
    const principal = outcome.principal;
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
    const view = await connections.getConnection(principal, match.params["id"] ?? "");
    sendJson(res, 200, toConnectionPayload(view, config.baseUrl));
  });

  router.post("/api/v1/connections/:id/authorize", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = await readOptionalBody(req);
    const returnTo = typeof body["return_to"] === "string" ? body["return_to"] : null;
    if (returnTo !== null && !isReturnUrlAllowed(returnTo, returnToOrigins)) {
      sendJson(res, 400, {
        error: "invalid_return_to",
        error_description:
          "return_to must point at the gateway or an origin listed in GATEWAY_RETURN_TO_ORIGINS",
      });
      return;
    }
    const result = await connections.startAuthorization({
      tenantId: principal.tenantId,
      userId: principal.userId,
      connectionId: match.params["id"] ?? "",
      returnTo,
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
    const sync = await connections.refresh(principal, match.params["id"] ?? "");
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
      principal,
      match.params["id"] ?? "",
      String(body["alias"] ?? ""),
    );
    sendJson(res, 200, toConnectionPayload(view, config.baseUrl));
  });

  router.post("/api/v1/connections/:id/enabled", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const body = parseJsonBody(await readBody(req, MAX_BODY));
    const view = await connections.setEnabled(
      principal,
      match.params["id"] ?? "",
      body["enabled"] === true,
    );
    sendJson(res, 200, toConnectionPayload(view, config.baseUrl));
  });

  router.delete("/api/v1/connections/:id", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    await connections.disconnect(principal, match.params["id"] ?? "");
    sendEmpty(res, 204);
  });

  router.get("/api/v1/tools", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const tools = await connections.listTools(principal);
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
      principal,
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
    const initialAccessToken = body["initial_access_token"];
    const method = String(body["token_endpoint_auth_method"] ?? "client_secret_basic");
    // Either an OAuth client the operator created in a portal, or a token that
    // lets the gateway register itself at a closed registration endpoint.
    const usable = clientId !== "" || typeof initialAccessToken === "string";
    if (!issuer || !usable || !isTokenEndpointAuthMethod(method)) {
      sendJson(res, 400, {
        error: "invalid_request",
        message:
          "issuer, a supported token_endpoint_auth_method, and either client_id " +
          "or initial_access_token are required",
      });
      return;
    }
    const seal = (value: unknown): Promise<string> | null =>
      typeof value === "string"
        ? services.vault.encrypt(
            { tenantId: principal.tenantId, purpose: "client_secret" },
            value,
          )
        : null;
    const record = await store.preconfiguredClients.upsert({
      id: newId("pcc"),
      tenantId: principal.tenantId,
      issuer,
      clientId,
      clientSecretEncrypted: await seal(body["client_secret"]),
      initialAccessTokenEncrypted: await seal(initialAccessToken),
      redirectUri: String(body["redirect_uri"] ?? identity.redirectUri),
      tokenEndpointAuthMethod: method,
      scopes: Array.isArray(body["scopes"]) ? (body["scopes"] as string[]) : null,
      createdAt: services.clock.now(),
    });
    sendJson(res, 201, { id: record.id, issuer: record.issuer });
  });

  /** Never includes the secret or the initial access token, only that one is held. */
  router.get("/api/v1/oauth-client-configurations", async (req, res) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const records = await store.preconfiguredClients.list(principal.tenantId);
    sendJson(res, 200, {
      oauth_client_configurations: records.map((record) => ({
        id: record.id,
        issuer: record.issuer,
        client_id: record.clientId,
        redirect_uri: record.redirectUri,
        token_endpoint_auth_method: record.tokenEndpointAuthMethod,
        scopes: record.scopes,
        has_client_secret: record.clientSecretEncrypted !== null,
        has_initial_access_token: record.initialAccessTokenEncrypted !== null,
        created_at: record.createdAt,
      })),
    });
  });

  router.delete("/api/v1/oauth-client-configurations/:id", async (req, res, match) => {
    const principal = await requirePrincipal(req, res);
    if (!principal) return;
    const removed = await store.preconfiguredClients.delete(
      principal.tenantId,
      match.params["id"] ?? "",
    );
    if (!removed) {
      sendJson(res, 404, {
        error: "not_found",
        message: "No such OAuth client configuration",
      });
      return;
    }
    sendEmpty(res, 204);
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
      const item = typeof entry === "string" ? { url: entry } : (entry as {
        url?: string;
        alias?: string;
      });
      const rawUrl = String(item?.url ?? "");
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
          // The name the user already gave this server in their client is a
          // better alias than anything derived from the hostname.
          ...(typeof item?.alias === "string" ? { alias: item.alias } : {}),
        });
        results.push({
          ...toConnectionPayload(view, config.baseUrl),
          url: canonical,
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

/**
 * The connection to send back through authorization after the gateway had to
 * register a replacement client, or null when the failure was something else.
 */
function replacedClientConnectionId(error: GatewayError): string | null {
  if (error.code !== "AUTHORIZATION_REQUIRED") return null;
  const data = error.data;
  if (!isRecord(data) || data["reason"] !== "client_replaced") return null;
  const id = data["connectionId"];
  return typeof id === "string" ? id : null;
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
