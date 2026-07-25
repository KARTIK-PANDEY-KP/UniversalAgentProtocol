import { describe, expect, it } from "vitest";

import {
  dedupeAlias,
  defaultAliasFor,
  gatewayToolName,
  isValidAlias,
  namespaceResultResources,
  sanitizeAlias,
} from "@uap/federation";

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

describe("resource uris inside results", () => {
  it("rewrites a resource link so the client can read what it points at", () => {
    const result = namespaceResultResources(
      {
        content: [
          { type: "text", text: "see also" },
          { type: "resource_link", uri: "demo://thing/1", name: "thing" },
        ],
      },
      "up",
    );
    const link = (result["content"] as Record<string, unknown>[])[1];
    expect(link?.["uri"]).toBe("up+demo://thing/1");
  });

  it("rewrites embedded resources and the contents of a read", () => {
    const embedded = namespaceResultResources(
      { content: [{ type: "resource", resource: { uri: "file:///a.txt", text: "a" } }] },
      "up",
    );
    const block = (embedded["content"] as Record<string, unknown>[])[0];
    expect((block?.["resource"] as Record<string, unknown>)["uri"]).toBe("up+file:///a.txt");

    const read = namespaceResultResources(
      { contents: [{ uri: "file:///a.txt", text: "a" }] },
      "up",
    );
    expect((read["contents"] as Record<string, unknown>[])[0]?.["uri"]).toBe("up+file:///a.txt");
  });

  it("rewrites a resource carried by a prompt message", () => {
    const result = namespaceResultResources(
      {
        messages: [
          {
            role: "user",
            content: { type: "resource", resource: { uri: "file:///a.txt", text: "a" } },
          },
        ],
      },
      "up",
    );
    const message = (result["messages"] as Record<string, unknown>[])[0];
    const content = message?.["content"] as Record<string, unknown>;
    expect((content["resource"] as Record<string, unknown>)["uri"]).toBe("up+file:///a.txt");
  });

  it("leaves a uri that is the tool's own data alone", () => {
    // A tool that answers with a record containing a uri field is reporting
    // data, not offering a resource to read.
    const result = namespaceResultResources(
      { content: [{ type: "text", text: "ok" }], structuredContent: { uri: "https://x.test/a" } },
      "up",
    );
    expect((result["structuredContent"] as Record<string, unknown>)["uri"]).toBe(
      "https://x.test/a",
    );
  });
});
