import type { JsonObject, JsonValue } from "./json-rpc.js";

/**
 * Protocol revisions the gateway understands, newest first. The gateway speaks
 * the newest revision a peer offers and falls back to its own latest when the
 * peer proposes something unknown, per the MCP version negotiation rules.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const LATEST_PROTOCOL_VERSION: ProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[0];

export const MCP_SESSION_HEADER = "mcp-session-id";
export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/**
 * The request authorization headers are being built for. Bearer tokens ignore
 * it; a DPoP proof is bound to exactly one method and URI, so the transport
 * has to say what it is about to send.
 */
export interface UpstreamRequestTarget {
  method: string;
  url: string;
}

export function negotiateProtocolVersion(requested: string): ProtocolVersion {
  const supported = SUPPORTED_PROTOCOL_VERSIONS as readonly string[];
  return supported.includes(requested)
    ? (requested as ProtocolVersion)
    : LATEST_PROTOCOL_VERSION;
}

export interface McpImplementation {
  name: string;
  title?: string;
  version: string;
}

export interface McpClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: JsonObject;
  elicitation?: JsonObject;
  experimental?: JsonObject;
}

export interface McpServerCapabilities {
  logging?: JsonObject;
  completions?: JsonObject;
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  experimental?: JsonObject;
}

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: McpClientCapabilities;
  clientInfo: McpImplementation;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpImplementation;
  instructions?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: JsonObject;
  size?: number;
  _meta?: JsonObject;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
  _meta?: JsonObject;
}

export interface McpToolResult {
  content: JsonValue[];
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}

export interface McpResourceContents {
  contents: JsonValue[];
}

export interface McpPromptResult {
  description?: string;
  messages: JsonValue[];
}

/** Methods the gateway proxies or answers on the northbound interface. */
export const McpMethod = {
  Initialize: "initialize",
  Initialized: "notifications/initialized",
  Ping: "ping",
  ToolsList: "tools/list",
  ToolsCall: "tools/call",
  ResourcesList: "resources/list",
  ResourcesTemplatesList: "resources/templates/list",
  ResourcesRead: "resources/read",
  ResourcesSubscribe: "resources/subscribe",
  ResourcesUnsubscribe: "resources/unsubscribe",
  PromptsList: "prompts/list",
  PromptsGet: "prompts/get",
  LoggingSetLevel: "logging/setLevel",
  CompletionComplete: "completion/complete",
  Cancelled: "notifications/cancelled",
  Progress: "notifications/progress",
  ToolListChanged: "notifications/tools/list_changed",
  ResourceListChanged: "notifications/resources/list_changed",
  ResourceUpdated: "notifications/resources/updated",
  PromptListChanged: "notifications/prompts/list_changed",
  LoggingMessage: "notifications/message",
  SamplingCreateMessage: "sampling/createMessage",
  ElicitationCreate: "elicitation/create",
  RootsList: "roots/list",
  RootsListChanged: "notifications/roots/list_changed",
} as const;

/** RFC 5424 severities, ordered as MCP orders them: least to most severe. */
export const MCP_LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

export function isMcpLogLevel(value: unknown): value is McpLogLevel {
  return (
    typeof value === "string" && (MCP_LOG_LEVELS as readonly string[]).includes(value)
  );
}

/** True when a message at `level` is at least as severe as `minimum`. */
export function meetsLogLevel(level: unknown, minimum: McpLogLevel): boolean {
  // An unrecognised severity is passed through rather than dropped: silently
  // discarding an upstream's log line is worse than showing one too many.
  if (!isMcpLogLevel(level)) return true;
  return MCP_LOG_LEVELS.indexOf(level) >= MCP_LOG_LEVELS.indexOf(minimum);
}
