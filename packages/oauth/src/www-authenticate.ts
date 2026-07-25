import type { WwwAuthenticateChallenge } from "@umg/core";

/**
 * Parses an RFC 7235 `WWW-Authenticate` header. MCP servers use it to point at
 * their protected resource metadata and to advertise the scopes a client
 * should request, so the parser has to survive multiple challenges and both
 * quoted and bare parameter values.
 */
export function parseWwwAuthenticate(
  header: string | undefined,
): WwwAuthenticateChallenge[] {
  if (!header) return [];
  const challenges: WwwAuthenticateChallenge[] = [];
  const tokenPattern = /([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]+))?/gu;

  let current: WwwAuthenticateChallenge | null = null;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(header)) !== null) {
    const name = match[1] ?? "";
    const rawValue = match[2];
    if (rawValue === undefined) {
      if (current) challenges.push(current);
      current = { scheme: name, params: {} };
      continue;
    }
    if (!current) current = { scheme: "Bearer", params: {} };
    current.params[name.toLowerCase()] = unquote(rawValue);
  }
  if (current) challenges.push(current);
  return challenges;
}

export function selectBearerChallenge(
  challenges: WwwAuthenticateChallenge[],
): WwwAuthenticateChallenge | undefined {
  return (
    challenges.find((challenge) => challenge.scheme.toLowerCase() === "bearer") ??
    challenges[0]
  );
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(.)/gu, "$1");
  }
  return value;
}
