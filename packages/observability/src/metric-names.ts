export const Metric = {
  OauthAuthorizationStarted: "oauth_authorization_started_total",
  OauthAuthorizationCompleted: "oauth_authorization_completed_total",
  OauthAuthorizationFailed: "oauth_authorization_failed_total",
  OauthTokenRefresh: "oauth_token_refresh_total",
  OauthTokenRefreshFailed: "oauth_token_refresh_failed_total",
  OauthReauthRequired: "oauth_reauth_required_total",
  OauthDcr: "oauth_dcr_total",
  OauthCimd: "oauth_cimd_total",
  OauthPreregistered: "oauth_preregistered_total",

  McpUpstreamConnection: "mcp_upstream_connection_total",
  McpUpstreamInitializationFailed: "mcp_upstream_initialization_failed_total",
  McpToolCall: "mcp_tool_call_total",
  McpToolCallFailed: "mcp_tool_call_failed_total",
  McpToolCallDuration: "mcp_tool_call_duration",
  McpSessionRecreated: "mcp_session_recreated_total",
  McpToolSchemaChanged: "mcp_tool_schema_changed_total",

  BackgroundJobRun: "background_job_run_total",
  BackgroundJobFailed: "background_job_failed_total",
  BackgroundJobDuration: "background_job_duration",
  CredentialRewrapped: "credential_rewrapped_total",
  SessionReaped: "session_reaped_total",

  SsrfRequestBlocked: "ssrf_request_blocked_total",
  InvalidIssuer: "invalid_issuer_total",
  InvalidState: "invalid_state_total",
  ResourceMismatch: "resource_mismatch_total",
  TenantAccessDenied: "tenant_access_denied_total",
  DestructiveToolConfirmation: "destructive_tool_confirmation_total",
  TokenDecryptionFailed: "token_decryption_failed_total",
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];
