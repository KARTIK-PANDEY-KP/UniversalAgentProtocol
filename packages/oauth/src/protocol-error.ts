import { clampText, isRecord, type OAuthErrorResponse } from "@umg/core";

export class OAuthProtocolError extends Error {
  readonly error: string;
  readonly description: string | undefined;
  readonly status: number;

  constructor(error: string, status: number, description?: string) {
    super(description ? `${error}: ${clampText(description, 200)}` : error);
    this.name = "OAuthProtocolError";
    this.error = error;
    this.description = description;
    this.status = status;
  }

  static fromBody(status: number, body: unknown, fallback: string): OAuthProtocolError {
    if (isRecord(body) && typeof body["error"] === "string") {
      const payload = body as OAuthErrorResponse;
      return new OAuthProtocolError(
        payload.error,
        status,
        typeof payload.error_description === "string"
          ? payload.error_description
          : undefined,
      );
    }
    return new OAuthProtocolError(fallback, status);
  }
}

export type RefreshFailureKind =
  | "REAUTH_REQUIRED"
  | "CLIENT_INVALID"
  | "INSUFFICIENT_SCOPE"
  | "TRANSIENT";

/**
 * Maps a token endpoint failure onto the action the gateway should take.
 * `invalid_grant` is terminal for the stored refresh token; network and 5xx
 * failures must never destroy a grant that is probably still valid.
 */
export function classifyTokenFailure(error: unknown): RefreshFailureKind {
  if (error instanceof OAuthProtocolError) {
    switch (error.error) {
      case "invalid_grant":
      case "unauthorized_client":
      case "access_denied":
        return "REAUTH_REQUIRED";
      case "invalid_client":
        return "CLIENT_INVALID";
      case "insufficient_scope":
      case "invalid_scope":
        return "INSUFFICIENT_SCOPE";
      case "server_error":
      case "temporarily_unavailable":
        return "TRANSIENT";
      default:
        return error.status >= 500 ? "TRANSIENT" : "REAUTH_REQUIRED";
    }
  }
  return "TRANSIENT";
}
