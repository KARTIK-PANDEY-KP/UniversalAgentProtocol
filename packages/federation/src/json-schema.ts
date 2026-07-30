import { isRecord, type JsonObject } from "@uap/core";

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * A deliberately small JSON Schema subset validator. The gateway only needs to
 * reject arguments that clearly violate the schema an upstream server
 * published; the upstream remains the authority on its own inputs.
 */
export function validateAgainstSchema(
  schema: JsonObject | null,
  value: unknown,
  path = "$",
): ValidationIssue[] {
  if (!schema) return [];
  const issues: ValidationIssue[] = [];
  const type = schema["type"];

  if (typeof type === "string" && !matchesType(type, value)) {
    issues.push({ path, message: `expected ${type}` });
    return issues;
  }
  if (Array.isArray(type) && !type.some((candidate) => matchesType(String(candidate), value))) {
    issues.push({ path, message: `expected one of ${type.join(", ")}` });
    return issues;
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => candidate === value)) {
    issues.push({ path, message: "value is not one of the allowed options" });
  }

  if (typeof value === "string") {
    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number" && value.length > maxLength) {
      issues.push({ path, message: `longer than ${maxLength} characters` });
    }
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      issues.push({ path, message: `shorter than ${minLength} characters` });
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string") {
      const expression = safeRegExp(pattern);
      // A pattern this validator cannot compile is not a failed argument. The
      // upstream is the authority on its own inputs, so an unreadable rule
      // means this check abstains rather than rejecting everything.
      if (expression && !expression.test(value)) {
        issues.push({ path, message: "does not match the required pattern" });
      }
    }
  }

  if (typeof value === "number") {
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      issues.push({ path, message: `below the minimum of ${minimum}` });
    }
    const maximum = schema["maximum"];
    if (typeof maximum === "number" && value > maximum) {
      issues.push({ path, message: `above the maximum of ${maximum}` });
    }
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (isRecord(items)) {
      value.forEach((item, index) => {
        issues.push(
          ...validateAgainstSchema(items as JsonObject, item, `${path}[${index}]`),
        );
      });
    }
    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      issues.push({ path, message: `more than ${maxItems} items` });
    }
  }

  if (isRecord(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in value)) {
          issues.push({ path: `${path}.${key}`, message: "is required" });
        }
      }
    }
    const properties = schema["properties"];
    if (isRecord(properties)) {
      for (const [key, child] of Object.entries(value)) {
        const childSchema = properties[key];
        if (isRecord(childSchema)) {
          issues.push(
            ...validateAgainstSchema(childSchema as JsonObject, child, `${path}.${key}`),
          );
        } else if (schema["additionalProperties"] === false) {
          issues.push({ path: `${path}.${key}`, message: "is not an allowed property" });
        }
      }
    }
  }

  return issues;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * JSON Schema patterns are ECMA-262 regular expressions, which is not the same
 * dialect as one compiled with the `u` flag: `[a-z\-]` and `\d{2}\-\d{2}` are
 * ordinary patterns that a unicode-mode compile rejects outright. Unicode mode
 * is tried first because it is the stricter reading, then plain mode, and a
 * pattern neither can compile is left to the upstream to enforce.
 */
function safeRegExp(pattern: string): RegExp | null {
  if (pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "u");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }
}
