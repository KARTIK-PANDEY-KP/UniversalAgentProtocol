import { describe, expect, it } from "vitest";

import { validateAgainstSchema } from "@uap/federation";

describe("schema validation", () => {
  it("enforces a pattern it understands", () => {
    const issues = validateAgainstSchema({ type: "string", pattern: "^[0-9]+$" }, "abc");
    expect(issues).toHaveLength(1);
  });

  it("accepts a pattern that only a non-unicode compile allows", () => {
    // `\-` inside a character class is an ordinary escape in JSON Schema and
    // an error under the `u` flag. Rejecting on it would refuse every value a
    // tool with this very common pattern accepts.
    const issues = validateAgainstSchema(
      { type: "string", pattern: "^[a-z\\-]+$" },
      "read-only",
    );
    expect(issues).toEqual([]);
  });

  it("abstains on a pattern no compile understands", () => {
    const issues = validateAgainstSchema(
      { type: "string", pattern: "^(unclosed" },
      "anything",
    );
    expect(issues).toEqual([]);
  });

  it("still rejects a value the rest of the schema forbids", () => {
    const issues = validateAgainstSchema(
      {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 } },
        required: ["count"],
      },
      { count: 0 },
    );
    expect(issues).toHaveLength(1);
  });
});
