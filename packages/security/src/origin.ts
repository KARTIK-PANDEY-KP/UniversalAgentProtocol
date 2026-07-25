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
