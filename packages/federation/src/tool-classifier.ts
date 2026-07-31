import { isRecord, type JsonObject, type ToolRiskLevel } from "@uap/core";

const PATTERNS: { level: ToolRiskLevel; pattern: RegExp }[] = [
  {
    // `exec` and its synonyms mean the tool does whatever the caller passes
    // it, so the only safe reading is the worst thing it could be asked to do.
    // `run` is left out: it prefaces too many harmless things — run_query,
    // run_report — to carry the same weight.
    level: "DESTRUCTIVE",
    pattern:
      /\b(delete|destroy|drop|purge|remove|erase|wipe|revoke|terminate|uninstall|exec|execute|eval|invoke|shell|spawn)\b/iu,
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

/** Verbs whose presence at the head of a name means the tool reads. */
const READ_VERBS =
  /^(get|list|read|search|find|query|describe|fetch|show|view|inspect|count|lookup)$/iu;

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
  const words = tokenize(name).split(" ");
  const haystack = `${words.join(" ")} ${description ?? ""}`;
  // MCP tool names read verb first, and the verb is the part that says whether
  // anything changes; the rest is the noun it acts on. Matching the whole name
  // lets that noun outrank the verb, which is how `get_merge_request` and
  // `search_comments` — both plainly reads — come out as writes, on the
  // strength of "merge" and "comment".
  //
  // Only the write reading is suppressed. A read verb is not licence to ignore
  // a destructive or administrative word, because the cost of being wrong runs
  // one way: too cautious is a confirmation prompt, too relaxed is a tool that
  // slipped past the policy meant to catch it.
  const readVerb = words[0] !== undefined && READ_VERBS.test(words[0]);
  for (const { level, pattern } of PATTERNS) {
    if (level === "WRITE" && readVerb) continue;
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
