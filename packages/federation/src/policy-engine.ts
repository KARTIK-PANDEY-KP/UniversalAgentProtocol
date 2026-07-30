import {
  GatewayError,
  type DiscoveredTool,
  type JsonObject,
  type ToolRiskLevel,
  type UpstreamConnection,
} from "@uap/core";

import { validateAgainstSchema } from "./json-schema.js";

export interface ToolPolicy {
  /** Risk classes that are never exposed. */
  blockedRiskLevels: ToolRiskLevel[];
  /** Risk classes that need an explicit human confirmation per call. */
  confirmationRiskLevels: ToolRiskLevel[];
  /** Hide tools that look destructive but were never reviewed. */
  disableUnknownDestructive: boolean;
  maxArgumentBytes: number;
  maxResultBytes: number;
  allowSampling: boolean;
  allowElicitation: boolean;
  /**
   * Whether an upstream may read the client's roots. The answer names
   * directories on the user's machine, which is worth being able to withhold
   * from a server that has no business knowing them.
   */
  allowRoots: boolean;
  /** Roles allowed to call write-class tools; empty means every member. */
  writeRoles: string[];
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  blockedRiskLevels: [],
  confirmationRiskLevels: ["DESTRUCTIVE", "FINANCIAL"],
  disableUnknownDestructive: true,
  maxArgumentBytes: 256 * 1024,
  maxResultBytes: 4 * 1024 * 1024,
  allowSampling: true,
  allowElicitation: true,
  allowRoots: true,
  writeRoles: [],
};

/**
 * `INVALID_ARGUMENTS` is separate from `DENY` because the protocol treats the
 * two differently: arguments that miss the tool's schema are a protocol error,
 * while a policy refusal is the gateway exercising judgement over a well-formed
 * call.
 */
export type PolicyOutcome =
  | "ALLOW"
  | "REQUIRE_CONFIRMATION"
  | "DENY"
  | "INVALID_ARGUMENTS";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason?: string;
}

export interface ToolCallPolicyInput {
  tool: DiscoveredTool;
  connection: UpstreamConnection;
  args: unknown;
  roles: string[];
}

/**
 * OAuth authorises access to an MCP server, not to every operation it exposes.
 * The policy engine is the second gate: it validates arguments, blocks tools an
 * operator disabled, and marks high-impact calls as needing confirmation.
 */
export class PolicyEngine {
  constructor(private readonly policy: ToolPolicy = DEFAULT_TOOL_POLICY) {}

  get settings(): ToolPolicy {
    return this.policy;
  }

  evaluateToolCall(input: ToolCallPolicyInput): PolicyDecision {
    if (!input.tool.enabled) {
      return { outcome: "DENY", reason: "This tool is disabled by policy" };
    }
    if (input.connection.status === "DISABLED") {
      return { outcome: "DENY", reason: "This connection is disabled" };
    }
    if (this.policy.blockedRiskLevels.includes(input.tool.riskLevel)) {
      return {
        outcome: "DENY",
        reason: `Tools classified ${input.tool.riskLevel} are blocked for this workspace`,
      };
    }
    if (
      this.policy.writeRoles.length > 0 &&
      input.tool.riskLevel !== "READ_ONLY" &&
      !input.roles.some((role) => this.policy.writeRoles.includes(role))
    ) {
      return { outcome: "DENY", reason: "Your role may only call read-only tools" };
    }

    const serialized = JSON.stringify(input.args ?? {});
    if (Buffer.byteLength(serialized) > this.policy.maxArgumentBytes) {
      return { outcome: "DENY", reason: "Tool arguments exceed the configured limit" };
    }

    const issues = validateAgainstSchema(input.tool.inputSchemaJson, input.args ?? {});
    if (issues.length > 0) {
      const detail = issues
        .slice(0, 3)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ");
      return {
        outcome: "INVALID_ARGUMENTS",
        reason: `Arguments do not match the tool schema: ${detail}`,
      };
    }

    if (this.policy.confirmationRiskLevels.includes(input.tool.riskLevel)) {
      return { outcome: "REQUIRE_CONFIRMATION" };
    }
    return { outcome: "ALLOW" };
  }

  /** Applied at discovery time to decide whether a tool is exposed at all. */
  shouldExposeTool(riskLevel: ToolRiskLevel, annotations: JsonObject | null): boolean {
    if (this.policy.blockedRiskLevels.includes(riskLevel)) return false;
    if (
      this.policy.disableUnknownDestructive &&
      riskLevel === "DESTRUCTIVE" &&
      (annotations === null || annotations["destructiveHint"] === undefined)
    ) {
      return false;
    }
    return true;
  }

  assertResultWithinLimits(result: unknown): void {
    const size = Buffer.byteLength(JSON.stringify(result ?? null));
    if (size > this.policy.maxResultBytes) {
      throw new GatewayError(
        "PAYLOAD_TOO_LARGE",
        "The upstream tool result exceeded the configured size limit",
      );
    }
  }

  /**
   * The three things an MCP server may ask a client for. Anything else an
   * upstream invents is refused: the gateway would be relaying a request its
   * client never agreed to answer.
   */
  allowsServerRequest(method: string): boolean {
    if (method.startsWith("sampling/")) return this.policy.allowSampling;
    if (method.startsWith("elicitation/")) return this.policy.allowElicitation;
    if (method.startsWith("roots/")) return this.policy.allowRoots;
    return false;
  }

  /**
   * What the gateway tells upstreams it can do on the client's behalf.
   * Advertising a capability the policy then refuses invites a server to
   * build a request that fails halfway through a tool call.
   */
  clientCapabilities(): {
    sampling?: JsonObject;
    elicitation?: JsonObject;
    roots?: { listChanged: boolean };
  } {
    return {
      ...(this.policy.allowSampling ? { sampling: {} } : {}),
      ...(this.policy.allowElicitation ? { elicitation: {} } : {}),
      ...(this.policy.allowRoots ? { roots: { listChanged: true } } : {}),
    };
  }
}
