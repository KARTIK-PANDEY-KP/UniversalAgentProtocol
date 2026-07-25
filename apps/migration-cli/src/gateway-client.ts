export interface ConnectionSummary {
  connection_id: string;
  alias: string;
  status: string;
  mcp_url: string;
  display_name: string;
  tool_count: number;
  last_error: string | null;
  authorization_url?: string;
  connect_url?: string;
}

export interface ImportItem {
  url: string;
  alias?: string;
}

export interface ImportOutcome {
  url: string;
  status: string;
  connection_id?: string;
  alias?: string;
  connect_url?: string;
  authorization_url?: string;
  message?: string;
}

export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

/**
 * Thin client for the gateway control plane. The CLI never sees an upstream
 * credential: it hands over URLs and receives back connection statuses and
 * browser links the user follows once per protected server.
 */
export class GatewayControlPlane {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.request("GET", "/healthz");
  }

  async importServers(items: ImportItem[]): Promise<ImportOutcome[]> {
    const body = await this.request<{ imported: ImportOutcome[] }>("POST", "/api/v1/import", {
      urls: items,
    });
    return body.imported ?? [];
  }

  async connections(): Promise<ConnectionSummary[]> {
    const body = await this.request<{ connections: ConnectionSummary[] }>(
      "GET",
      "/api/v1/connections",
    );
    return body.connections ?? [];
  }

  async connection(id: string): Promise<ConnectionSummary> {
    return this.request("GET", `/api/v1/connections/${encodeURIComponent(id)}`);
  }

  async authorize(id: string): Promise<string> {
    const body = await this.request<{ authorization_url: string }>(
      "POST",
      `/api/v1/connections/${encodeURIComponent(id)}/authorize`,
      {},
    );
    return body.authorization_url;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new GatewayRequestError(
        response.status,
        text,
        `${method} ${path} failed with ${response.status}: ${summarize(text)}`,
      );
    }
    return (text === "" ? {} : JSON.parse(text)) as T;
  }
}

function summarize(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}
