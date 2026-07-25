import { isRecord, type JsonObject, type ToolRiskLevel } from "@umg/core";

const PATTERNS: { level: ToolRiskLevel; pattern: RegExp }[] = [
  {
    level: "DESTRUCTIVE",
    pattern: /\b(delete|destroy|drop|purge|remove|erase|wipe|revoke|terminate|uninstall)\b/iu,
  },
  // "subscription" is deliberately absent. MCP uses the word for resource
  // subscriptions, so it appears in tools that have nothing to do with money,
  // and a FINANCIAL guess costs the user a confirmation prompt on every call.
  { level: "FINANCIAL", pattern: /\b(pay|payment|charge|invoice|refund|transfer|billing)\b/iu },
  { level: "ADMINISTRATIVE", pattern: /\b(admin|grant|permission|role|policy|member|owner|acl|scope)\b/iu },
  {
    level: "EXTERNAL_COMMUNICATION",
    pattern: /\b(send|email|mail|message|notify|sms|call|post_to|publish|broadcast|dm)\b/iu,
  },
  {
    level: "WRITE",
    pattern: /\b(create|update|write|edit|set|add|append|upload|merge|patch|rename|move|assign|close|open|comment)\b/iu,
  },
  {
    level: "READ_ONLY",
    pattern: /\b(get|list|read|search|find|query|describe|fetch|show|view|inspect|count)\b/iu,
  },
];

/**
 * Classifies a tool from the generic signals MCP exposes: the standard
 * annotation hints first, then a name and description heuristic. No provider
 * specific knowledge is involved, and anything unrecognised stays UNKNOWN so
 * policy can treat it conservatively.
 */
export function classifyTool(
  name: string,
  description: string | null,
  annotations: JsonObject | null,
): ToolRiskLevel {
  if (isRecord(annotations)) {
    if (annotations["destructiveHint"] === true) return "DESTRUCTIVE";
    if (annotations["readOnlyHint"] === true) return "READ_ONLY";
  }
  const haystack = `${tokenize(name)} ${description ?? ""}`;
  for (const { level, pattern } of PATTERNS) {
    if (pattern.test(haystack)) {
      if (
        level === "WRITE" &&
        isRecord(annotations) &&
        annotations["openWorldHint"] === true
      ) {
        return "EXTERNAL_COMMUNICATION";
      }
      return level;
    }
  }
  return "UNKNOWN";
}

/**
 * Splits a tool name into words. MCP tool names are almost always snake_case
 * or camelCase, where a word-boundary match would never fire: `delete` inside
 * `delete_repository` has word characters on both sides.
 */
function tokenize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/gu, " ")
    .trim();
}
