import { isRecord } from "@umg/core";

/**
 * Property names whose values must never reach a log sink, a trace, or a
 * persisted error field. Matching is case-insensitive and substring based so
 * that variants such as `upstreamAccessToken` are also caught.
 */
const SECRET_KEY_FRAGMENTS = [
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "client_secret",
  "clientsecret",
  "code_verifier",
  "codeverifier",
  "pkce",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "passphrase",
  "private_key",
  "privatekey",
  "secret",
  "api_key",
  "apikey",
  "registration_access_token",
  "session_id",
  "sessionid",
  "mcp-session-id",
  "dpop",
  "assertion",
  "client_assertion",
];

/** Authorization codes and bearer tokens that leak through free-form strings. */
const VALUE_PATTERNS: RegExp[] = [
  /\b(?:Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\b(?:access_token|refresh_token|code|code_verifier|client_secret)=([^&\s"']+)/giu,
  /\beyJ[A-Za-z0-9._-]{20,}/gu,
];

export const REDACTED = "[REDACTED]";

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function redactString(value: string): string {
  let output = value;
  for (const pattern of VALUE_PATTERNS) {
    // A pattern without a capture group replaces the whole match; one with a
    // group keeps the surrounding text so the log still says which parameter
    // was present. The second replacer argument is the offset rather than a
    // group when the pattern captures nothing, hence the type check.
    output = output.replace(pattern, (match, capture: unknown) =>
      typeof capture === "string" ? match.replace(capture, REDACTED) : REDACTED,
    );
  }
  return output;
}

/**
 * Deep-copies a value, replacing anything that looks like a credential. The
 * copy is bounded in depth so a hostile upstream payload cannot cause the
 * logger to recurse without limit.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}
