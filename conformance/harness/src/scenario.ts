import { completeAuthorization, type AuthorizationOutcome } from "./browser.js";
import type { ConnectionSummary, GatewayFixture } from "./gateway-fixture.js";
import {
  MockAuthorizationServer,
  type MockAuthorizationServerOptions,
} from "./mock-authorization-server.js";
import { MockMcpServer, type MockMcpServerOptions } from "./mock-mcp-server.js";

export interface ProtectedUpstream {
  authorizationServer: MockAuthorizationServer;
  mcpServer: MockMcpServer;
  url: string;
  stop(): Promise<void>;
}

/**
 * Starts an authorization server and an MCP server protected by it, wired
 * together the way a real deployment is: the MCP server publishes protected
 * resource metadata pointing at the issuer and validates bearer tokens the
 * issuer minted.
 */
export async function startProtectedUpstream(options: {
  authorizationServer?: MockAuthorizationServerOptions;
  mcpServer?: Omit<
    MockMcpServerOptions,
    "requireAuth" | "authorizationServers" | "introspect"
  >;
  scopesSupported?: string[];
} = {}): Promise<ProtectedUpstream> {
  const authorizationServer = new MockAuthorizationServer({
    scopesSupported: options.scopesSupported ?? ["mcp:read", "mcp:write"],
    ...(options.authorizationServer ?? {}),
  });
  await authorizationServer.start();

  const mcpServer = new MockMcpServer({
    ...(options.mcpServer ?? {}),
    requireAuth: true,
    authorizationServers: [authorizationServer.issuer],
    scopesSupported: options.scopesSupported ?? ["mcp:read", "mcp:write"],
    introspect: (token) => authorizationServer.introspect(token),
  });
  await mcpServer.start();

  return {
    authorizationServer,
    mcpServer,
    url: mcpServer.url,
    stop: async () => {
      await mcpServer.stop();
      await authorizationServer.stop();
    },
  };
}

export interface ConnectResult {
  connection: ConnectionSummary;
  authorization: AuthorizationOutcome;
}

/**
 * Runs the whole "connect this MCP server once" journey: create the
 * connection, obtain the authorization URL and complete the browser flow.
 */
export async function connectUpstream(
  gateway: GatewayFixture,
  mcpUrl: string,
  extra: Record<string, unknown> = {},
): Promise<ConnectResult> {
  const created = await gateway.createConnection(mcpUrl, extra);
  const authorizationUrl =
    created.authorization_url ?? (await gateway.authorizeUrl(created.connection_id));
  const authorization = await completeAuthorization(authorizationUrl, {
    gatewayApiKey: gateway.apiKey,
    gatewayBaseUrl: gateway.baseUrl,
  });
  return {
    connection: await gateway.getConnection(created.connection_id),
    authorization,
  };
}
