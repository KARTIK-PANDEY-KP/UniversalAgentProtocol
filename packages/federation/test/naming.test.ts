import { describe, expect, it } from "vitest";

import {
  dedupeAlias,
  defaultAliasFor,
  gatewayToolName,
  isValidAlias,
  sanitizeAlias,
} from "@umg/federation";

describe("alias naming", () => {
  it("keeps a sanitized alias within what the gateway accepts", () => {
    // Long enough that the cut lands on a separator, which left at the end
    // would produce an alias the validator rejects.
    const alias = sanitizeAlias(`${"a".repeat(39)}-${"b".repeat(20)}`);
    expect(alias.length).toBeLessThanOrEqual(40);
    expect(isValidAlias(alias)).toBe(true);
  });

  it("keeps a deduplicated alias within what the gateway accepts", () => {
    const base = sanitizeAlias("x".repeat(40));
    const taken = [base, `${base.slice(0, 38)}_2`];
    const alias = dedupeAlias(base, taken);
    expect(taken).not.toContain(alias);
    expect(isValidAlias(alias)).toBe(true);
  });

  it("derives a distinct alias per host and never repeats one", () => {
    const first = defaultAliasFor("https://mcp.notion.com/mcp", []);
    const second = defaultAliasFor("https://notion.example.org/mcp", [first]);
    expect(first).toBe("notion");
    expect(second).not.toBe(first);
    expect(isValidAlias(second)).toBe(true);
  });
});

describe("tool naming", () => {
  it("gives two upstream tools of the same name two gateway names", () => {
    const taken = new Set<string>();
    const names = ["send", "send", "send"].map((upstream) => {
      const name = gatewayToolName("up", upstream, taken);
      taken.add(name);
      return name;
    });
    expect(new Set(names).size).toBe(3);
  });

  it("keeps a truncated name unique and within the length limit", () => {
    const taken = new Set<string>();
    const long = "z".repeat(200);
    const first = gatewayToolName("up", `${long}a`, taken);
    taken.add(first);
    const second = gatewayToolName("up", `${long}b`, taken);
    expect(first).not.toBe(second);
    for (const name of [first, second]) expect(name.length).toBeLessThanOrEqual(128);
  });
});
