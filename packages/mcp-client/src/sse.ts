import type { Readable } from "node:stream";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Minimal `text/event-stream` reader. MCP only needs the `event`, `data` and
 * `id` fields, and treats every other field as a comment.
 */
export async function* readSseEvents(
  stream: Readable,
  maxEventBytes = 8 * 1024 * 1024,
): AsyncGenerator<SseEvent> {
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;

  const flush = (): SseEvent | null => {
    if (data.length === 0 && event === "message") return null;
    const payload: SseEvent = { event, data: data.join("\n") };
    if (id !== undefined) payload.id = id;
    event = "message";
    data = [];
    id = undefined;
    return payload;
  };

  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (buffer.length > maxEventBytes) {
      throw new Error("Server-sent event exceeded the maximum allowed size");
    }
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (rawLine === "") {
        const ready = flush();
        if (ready) yield ready;
        continue;
      }
      if (rawLine.startsWith(":")) continue;
      const colon = rawLine.indexOf(":");
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      let value = colon === -1 ? "" : rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      switch (field) {
        case "event":
          event = value;
          break;
        case "data":
          data.push(value);
          break;
        case "id":
          id = value;
          break;
        default:
          break;
      }
    }
  }
  const trailing = flush();
  if (trailing) yield trailing;
}
