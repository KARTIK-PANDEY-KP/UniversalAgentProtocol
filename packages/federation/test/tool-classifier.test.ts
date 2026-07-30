import { describe, expect, it } from "vitest";

import { classifyTool } from "@uap/federation";

describe("tool classification", () => {
  it("takes the server's explicit hints over the wording", () => {
    expect(classifyTool("tidy_up", "Cleans a workspace", { destructiveHint: true })).toBe(
      "DESTRUCTIVE",
    );
    expect(classifyTool("delete_everything", null, { readOnlyHint: true })).toBe("READ_ONLY");
  });

  it("reads the risk out of a name written in either common style", () => {
    expect(classifyTool("delete_repository", null, null)).toBe("DESTRUCTIVE");
    expect(classifyTool("deleteRepository", null, null)).toBe("DESTRUCTIVE");
  });

  it("does not mistake a resource subscription for a payment", () => {
    // MCP calls its own resource notifications subscriptions, so the word
    // turns up in tools that never touch money. Guessing FINANCIAL puts a
    // confirmation prompt in front of every call to them.
    expect(
      classifyTool(
        "toggle-subscriber-updates",
        "Toggles simulated resource subscription updates on or off.",
        { readOnlyHint: false, destructiveHint: false },
      ),
    ).not.toBe("FINANCIAL");
    expect(classifyTool("subscribe_to_resource", "Subscribe to a resource", null)).not.toBe(
      "FINANCIAL",
    );
  });

  it("still recognises money when the tool is about money", () => {
    expect(classifyTool("create_invoice", "Raises an invoice", null)).toBe("FINANCIAL");
    expect(classifyTool("refund_order", null, null)).toBe("FINANCIAL");
  });

  it("leaves a tool it cannot read as unknown rather than guessing", () => {
    expect(classifyTool("frobnicate", "Frobnicates the widget", null)).toBe("UNKNOWN");
  });

  it("treats a write against the open world as reaching outside", () => {
    expect(classifyTool("create_post", "Creates a post", { openWorldHint: true })).toBe(
      "EXTERNAL_COMMUNICATION",
    );
  });
});
