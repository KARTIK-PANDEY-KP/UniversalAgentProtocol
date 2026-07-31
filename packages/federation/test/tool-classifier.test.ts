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

  it("reads the verb, not the noun it acts on", () => {
    // Every one of these is a read whose subject happens to be named after a
    // write. Matching the whole name lets the noun win, and the tool is then
    // gated as if it changed something.
    expect(classifyTool("get_merge_request", "Fetches a merge request", null)).toBe(
      "READ_ONLY",
    );
    expect(classifyTool("list_merge_request_comments", null, null)).toBe("READ_ONLY");
    expect(classifyTool("search_comments", "Searches comments", null)).toBe("READ_ONLY");
    expect(classifyTool("list_open_issues", null, null)).toBe("READ_ONLY");
  });

  it("does not let a reading verb excuse a destructive one", () => {
    // The suppression is only of the write reading. Being too cautious costs a
    // confirmation prompt; being too relaxed lets a tool past the policy meant
    // to catch it, so a read verb never lowers the verdict below a write.
    expect(classifyTool("search_and_delete", "Finds and removes matches", null)).toBe(
      "DESTRUCTIVE",
    );
    expect(classifyTool("get_role", "Reads one role", null)).toBe("ADMINISTRATIVE");
  });

  it("treats a tool that runs whatever it is given as destructive", () => {
    // Its risk is whatever the caller asks of it, so the only safe reading is
    // the worst one. PostHog's MCP server exposes exactly this, under `exec`.
    expect(classifyTool("exec", "Execute a PostHog API operation", null)).toBe("DESTRUCTIVE");
    expect(classifyTool("execute_sql", null, null)).toBe("DESTRUCTIVE");
    expect(classifyTool("eval_expression", null, null)).toBe("DESTRUCTIVE");
    // `run` is too common in harmless tools to carry the same weight.
    expect(classifyTool("run_report", "Runs a saved report", null)).not.toBe("DESTRUCTIVE");
  });

  it("treats a write against the open world as reaching outside", () => {
    expect(classifyTool("create_post", "Creates a post", { openWorldHint: true })).toBe(
      "EXTERNAL_COMMUNICATION",
    );
  });
});
