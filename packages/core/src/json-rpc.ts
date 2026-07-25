export const JSONRPC_VERSION = "2.0" as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: JsonObject;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Standard JSON-RPC 2.0 error codes plus the MCP reserved range. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP: the request was cancelled or the resource was not found. */
  ResourceNotFound: -32002,
  /** Gateway specific: the upstream connection needs a new authorization. */
  AuthorizationRequired: -32001,
  /** Gateway specific: blocked by policy. */
  PolicyDenied: -32003,
  /** Gateway specific: upstream temporarily unavailable. */
  UpstreamUnavailable: -32004,
  /** Gateway specific: the caller exceeded its rate limit. */
  RateLimited: -32005,
} as const;

export function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isJsonRpcEnvelope(value)) return false;
  return typeof value["method"] === "string" && isRequestId(value["id"]);
}

export function isJsonRpcNotification(
  value: unknown,
): value is JsonRpcNotification {
  if (!isJsonRpcEnvelope(value)) return false;
  return typeof value["method"] === "string" && !("id" in value);
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isJsonRpcEnvelope(value)) return false;
  if (!("result" in value) && !("error" in value)) return false;
  // A response answers something, so it carries the id it answers. Null is
  // permitted only for a failure the peer could not attribute to a request.
  return isRequestId(value["id"]) || ("error" in value && value["id"] === null);
}

export function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  return isJsonRpcResponse(value) && "error" in value;
}

function isJsonRpcEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["jsonrpc"] === JSONRPC_VERSION
  );
}

export function jsonRpcSuccess(
  id: RequestId,
  result: JsonObject,
): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcFailure(
  id: RequestId | null,
  code: number,
  message: string,
  data?: JsonValue,
): JsonRpcFailure {
  const error: JsonRpcErrorBody =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSONRPC_VERSION, id, error };
}
