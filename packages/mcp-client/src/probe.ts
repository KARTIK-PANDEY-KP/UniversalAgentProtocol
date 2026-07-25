import {
  GatewayError,
  type McpImplementation,
  type McpInitializeResult,
  type TransportType,
} from "@umg/core";
import type { Logger, MetricsRegistry } from "@umg/observability";
import type { SafeFetcher } from "@umg/security";

import { UpstreamMcpConnection } from "./connection.js";
import { McpUnauthorizedError } from "./transport.js";

export interface ProbeOptions {
  url: string;
  fetcher: SafeFetcher;
  logger: Logger;
  metrics: MetricsRegistry;
  clientInfo: McpImplementation;
  authHeaders?: () => Promise<Record<string, string>>;
  timeoutMs?: number;
}

export interface ProbeResult {
  reachable: boolean;
  authorizationRequired: boolean;
  wwwAuthenticate?: string;
  transportType: TransportType;
  initializeResult?: McpInitializeResult;
}

/**
 * Determines whether a URL speaks MCP, which transport it uses and whether it
 * demands authorization. This is the first step of adding any connection and
 * is deliberately provider agnostic.
 */
export async function probeMcpEndpoint(options: ProbeOptions): Promise<ProbeResult> {
  const attempts: TransportType[] = ["STREAMABLE_HTTP", "HTTP_SSE"];
  let lastError: unknown;

  for (const transportType of attempts) {
    const connection = new UpstreamMcpConnection({
      url: options.url,
      fetcher: options.fetcher,
      logger: options.logger,
      metrics: options.metrics,
      authHeaders: options.authHeaders ?? (async () => ({})),
      clientInfo: options.clientInfo,
      clientCapabilities: {},
      transportKind: transportType === "HTTP_SSE" ? "HTTP_SSE" : "STREAMABLE_HTTP",
      ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
    });
    try {
      const initializeResult = await connection.initialize();
      await connection.close();
      return {
        reachable: true,
        authorizationRequired: false,
        transportType,
        initializeResult,
      };
    } catch (error) {
      await connection.close().catch(() => undefined);
      if (error instanceof McpUnauthorizedError) {
        const result: ProbeResult = {
          reachable: true,
          authorizationRequired: true,
          transportType,
        };
        if (error.wwwAuthenticate) result.wwwAuthenticate = error.wwwAuthenticate;
        return result;
      }
      lastError = error;
    }
  }

  if (lastError instanceof GatewayError && lastError.code === "UPSTREAM_UNAVAILABLE") {
    throw new GatewayError(
      "UPSTREAM_UNAVAILABLE",
      "Unable to reach MCP server. Verify the URL or network access.",
      { cause: lastError },
    );
  }
  throw new GatewayError(
    "NOT_AN_MCP_SERVER",
    "The endpoint did not complete MCP initialization.",
    { cause: lastError },
  );
}
