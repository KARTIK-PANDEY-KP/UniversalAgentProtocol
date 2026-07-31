import { GatewayError } from "@uap/core";

export interface UrlPolicy {
  /** Plain HTTP is only acceptable for local development and test fixtures. */
  allowHttp: boolean;
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export function parseAbsoluteUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GatewayError("INVALID_REQUEST", `Not an absolute URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayError(
      "INVALID_REQUEST",
      `Unsupported URL scheme: ${url.protocol}`,
    );
  }
  return url;
}

/**
 * Produces the canonical form used both as a storage key and as the RFC 8707
 * `resource` value: lower-cased scheme and host, no default port, no fragment,
 * no trailing slash, path preserved because it distinguishes MCP endpoints
 * hosted on the same origin.
 */
export function canonicalizeUrl(input: string | URL, policy: UrlPolicy): string {
  const url = typeof input === "string" ? parseAbsoluteUrl(input) : new URL(input.href);
  if (url.protocol === "http:" && !policy.allowHttp) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "Remote MCP servers must be reachable over HTTPS",
    );
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.port === DEFAULT_PORTS[url.protocol]) url.port = "";
  let path = url.pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path === "/" ? "" : path;
  return url.toString().replace(/\/$/u, "");
}

/**
 * The form an issuer is stored and compared under. RFC 8414 compares issuers
 * as exact strings, but the same authorization server is routinely advertised
 * with and without a trailing slash, and treating those as two servers would
 * mint two records for one issuer.
 */
export function canonicalIssuer(issuer: string): string {
  return issuer.replace(/\/+$/u, "");
}

export function sameIssuer(left: string, right: string): boolean {
  return canonicalIssuer(left) === canonicalIssuer(right);
}

export function issuerToWellKnown(issuer: string, suffix: string): string[] {
  const url = parseAbsoluteUrl(issuer);
  const path = url.pathname.replace(/\/+$/u, "");
  const origin = `${url.protocol}//${url.host}`;
  if (path === "" || path === "/") {
    return [`${origin}/.well-known/${suffix}`];
  }
  // RFC 8414 inserts the well-known segment before the issuer path; OpenID
  // Connect Discovery appends it. Capable clients try both.
  return [
    `${origin}/.well-known/${suffix}${path}`,
    `${origin}${path}/.well-known/${suffix}`,
  ];
}

/** RFC 9728 well-known locations derived from the resource URL. */
/**
 * What identifies a protected resource for OAuth: its origin and its path.
 *
 * The query is not part of it, because RFC 9728 derives the metadata URL from
 * the path alone. Two URLs differing only in their query therefore share one
 * metadata document by construction, and a server has no way to describe them
 * separately — so treating them as different resources is asking for a
 * distinction the protocol cannot express. Endpoints that carry configuration
 * in the query, as Supabase's MCP server carries its project reference, are
 * unreachable otherwise.
 *
 * This is narrower than `canonicalizeUrl`, which keeps the query and is what
 * identifies a *connection*: two projects on one host are two connections, and
 * collapsing them would be a tenant's data in the wrong place. They are
 * different questions and the answers differ.
 */
export function resourceIdentifier(input: string, policy: UrlPolicy): string {
  const url = new URL(canonicalizeUrl(input, policy));
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

export function resourceMetadataCandidates(resourceUrl: string): string[] {
  const url = parseAbsoluteUrl(resourceUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  const origin = `${url.protocol}//${url.host}`;
  const candidates = [`${origin}/.well-known/oauth-protected-resource${path}`];
  if (path !== "") candidates.push(`${origin}/.well-known/oauth-protected-resource`);
  return candidates;
}
