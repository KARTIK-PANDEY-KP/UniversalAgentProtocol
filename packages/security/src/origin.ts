/**
 * Streamable HTTP endpoints are reachable from a browser, so the gateway
 * rejects cross-origin requests that carry an `Origin` the operator has not
 * allowed. This is the DNS-rebinding protection required for any deployment
 * that can be reached from a local network.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  // Non-browser MCP clients omit Origin entirely.
  if (origin === undefined || origin === "") return true;
  if (allowedOrigins.includes("*")) return true;
  const normalized = origin.replace(/\/+$/u, "").toLowerCase();
  return allowedOrigins.some(
    (allowed) => allowed.replace(/\/+$/u, "").toLowerCase() === normalized,
  );
}

/**
 * True when a post-authorization redirect target is one the operator allowed.
 *
 * The gateway sends the user's browser here after a successful OAuth flow, so
 * an unchecked value turns a legitimate consent screen into a phishing hop.
 * Only absolute URLs whose origin is explicitly allowed pass.
 */
export function isReturnUrlAllowed(
  returnTo: string,
  allowedOrigins: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(returnTo);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return isOriginAllowed(parsed.origin, allowedOrigins);
}
