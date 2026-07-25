import { parseScopes } from "@umg/core";

import { parseWwwAuthenticate, selectBearerChallenge } from "./www-authenticate.js";

/**
 * An upstream can tell us a token is too narrow in two ways: the RFC 6750 way,
 * a `403` carrying `WWW-Authenticate: Bearer error="insufficient_scope"`, or by
 * failing the JSON-RPC call with a message naming the error. Both mean the same
 * thing to the gateway — the grant has to be widened — so both are recognised.
 *
 * Returns the scopes the upstream asked for, which may be empty when it said
 * only that the token was insufficient. Returns null when this is some other
 * failure.
 */
export function insufficientScopeFrom(error: unknown): string[] | null {
  const challenge = challengeHeaderOf(error);
  if (challenge !== undefined) {
    const bearer = selectBearerChallenge(parseWwwAuthenticate(challenge));
    if (bearer?.params["error"] === "insufficient_scope") {
      return parseScopes(bearer.params["scope"] ?? "");
    }
  }

  const message = error instanceof Error ? error.message : "";
  if (!message.includes("insufficient_scope")) return null;
  // `insufficient_scope: repo:write issues:write`
  const trailing = message.split("insufficient_scope")[1] ?? "";
  return parseScopes(trailing.replace(/^[\s:,]+/u, "").replace(/["'.]/gu, ""));
}

function challengeHeaderOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { wwwAuthenticate?: unknown }).wwwAuthenticate;
  return typeof candidate === "string" ? candidate : undefined;
}
