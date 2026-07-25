import type { IncomingMessage, ServerResponse } from "node:http";

import { GatewayError } from "@umg/core";

export async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxBytes) {
      throw new GatewayError("PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(
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

export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, headers);
  res.end();
}

/** Opens a `text/event-stream` response and returns a writer for MCP messages. */
export function openEventStream(
  res: ServerResponse,
  headers: Record<string, string> = {},
): EventStreamWriter {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...headers,
  });
  return new EventStreamWriter(res);
}

export class EventStreamWriter {
  private closed = false;
  private eventId = 0;

  constructor(private readonly res: ServerResponse) {
    res.on("close", () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded;
  }

  write(message: unknown): void {
    if (this.isClosed) return;
    this.eventId += 1;
    this.res.write(
      `id: ${this.eventId}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`,
    );
  }

  comment(text: string): void {
    if (this.isClosed) return;
    this.res.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.isClosed) return;
    this.closed = true;
    this.res.end();
  }
}

export function headerValue(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
