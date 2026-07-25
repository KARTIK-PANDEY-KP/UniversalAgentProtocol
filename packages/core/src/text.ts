/** Splits an OAuth scope string. Whitespace is the separator; commas are tolerated. */
export function parseScopes(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/u).filter((scope) => scope.length > 0);
}

export function formatScopes(scopes: readonly string[]): string {
  return scopes.join(" ");
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Truncates untrusted text before it reaches logs or persisted error fields. */
export function clampText(value: string, max = 512): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
