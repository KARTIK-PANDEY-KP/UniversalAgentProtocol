import { JsonRpcErrorCode, type JsonValue } from "./json-rpc.js";

export type GatewayErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "TENANT_MISMATCH"
  | "CONFLICT"
  | "AUTHORIZATION_REQUIRED"
  | "CLIENT_CREDENTIALS_REQUIRED"
  | "POLICY_DENIED"
  | "SSRF_BLOCKED"
  | "DISCOVERY_FAILED"
  | "ISSUER_MISMATCH"
  | "RESOURCE_MISMATCH"
  | "REGISTRATION_FAILED"
  | "TOKEN_EXCHANGE_FAILED"
  | "TOKEN_REFRESH_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_PROTOCOL_ERROR"
  | "NOT_AN_MCP_SERVER"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL";

export interface GatewayErrorOptions {
  /** Machine-readable payload safe to return to downstream clients. */
  data?: JsonValue;
  cause?: unknown;
  /** HTTP status to use when the error surfaces on the REST control plane. */
  httpStatus?: number;
  retryable?: boolean;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly data: JsonValue | undefined;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options: GatewayErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "GatewayError";
    this.code = code;
    this.data = options.data;
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
    this.retryable = options.retryable ?? false;
  }

  toJsonRpcCode(): number {
    switch (this.code) {
      case "AUTHORIZATION_REQUIRED":
      case "CLIENT_CREDENTIALS_REQUIRED":
        return JsonRpcErrorCode.AuthorizationRequired;
      case "POLICY_DENIED":
      case "FORBIDDEN":
      case "TENANT_MISMATCH":
        return JsonRpcErrorCode.PolicyDenied;
      case "UPSTREAM_UNAVAILABLE":
      case "UPSTREAM_PROTOCOL_ERROR":
        return JsonRpcErrorCode.UpstreamUnavailable;
      case "NOT_FOUND":
        return JsonRpcErrorCode.ResourceNotFound;
      case "INVALID_REQUEST":
      case "PAYLOAD_TOO_LARGE":
        return JsonRpcErrorCode.InvalidParams;
      case "RATE_LIMITED":
        return JsonRpcErrorCode.RateLimited;
      case "UNAUTHENTICATED":
      case "CONFLICT":
      case "SSRF_BLOCKED":
      case "DISCOVERY_FAILED":
      case "ISSUER_MISMATCH":
      case "RESOURCE_MISMATCH":
      case "REGISTRATION_FAILED":
      case "TOKEN_EXCHANGE_FAILED":
      case "TOKEN_REFRESH_FAILED":
      case "NOT_AN_MCP_SERVER":
      case "INTERNAL":
        return JsonRpcErrorCode.InternalError;
      default: {
        const exhaustive: never = this.code;
        void exhaustive;
        return JsonRpcErrorCode.InternalError;
      }
    }
  }
}

function defaultHttpStatus(code: GatewayErrorCode): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "SSRF_BLOCKED":
    case "ISSUER_MISMATCH":
    case "RESOURCE_MISMATCH":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
    case "TENANT_MISMATCH":
    case "POLICY_DENIED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "RATE_LIMITED":
      return 429;
    case "AUTHORIZATION_REQUIRED":
    case "CLIENT_CREDENTIALS_REQUIRED":
      return 428;
    case "UPSTREAM_UNAVAILABLE":
      return 502;
    case "DISCOVERY_FAILED":
    case "REGISTRATION_FAILED":
    case "TOKEN_EXCHANGE_FAILED":
    case "TOKEN_REFRESH_FAILED":
    case "UPSTREAM_PROTOCOL_ERROR":
    case "NOT_AN_MCP_SERVER":
      return 502;
    case "INTERNAL":
      return 500;
    default: {
      const exhaustive: never = code;
      void exhaustive;
      return 500;
    }
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

export function toGatewayError(value: unknown): GatewayError {
  if (isGatewayError(value)) return value;
  if (value instanceof Error) {
    return new GatewayError("INTERNAL", value.message, { cause: value });
  }
  return new GatewayError("INTERNAL", "Unknown error", { cause: value });
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
