import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureRequest {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: string;
  raw: IncomingMessage;
}

export type FixtureHandler = (
  request: FixtureRequest,
  res: ServerResponse,
) => Promise<void> | void;

/**
 * Minimal HTTP server used by the mock authorization and MCP servers. It binds
 * to an ephemeral loopback port so a test can run several fixtures at once.
 */
export class HttpFixture {
  private server: Server | null = null;
  private origin = "";

  constructor(private readonly handler: FixtureHandler) {}

  get baseUrl(): string {
    if (!this.origin) throw new Error("Fixture has not been started");
    return this.origin;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readAll(req);
      const url = new URL(req.url ?? "/", this.origin);
      await this.handler(
        { method: req.method ?? "GET", url, headers: req.headers, body, raw: req },
        res,
      );
      if (!res.writableEnded && !res.headersSent) {
        json(res, 404, { error: "not_found", path: url.pathname });
      }
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, { error: "fixture_error", message: (error as Error).message });
      } else {
        res.end();
      }
    }
  }
}

async function readAll(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function text(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "content-length": 0 });
  res.end();
}

export function headerOf(
  request: FixtureRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
