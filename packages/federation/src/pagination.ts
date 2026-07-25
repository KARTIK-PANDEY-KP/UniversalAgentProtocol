import { GatewayError } from "@uap/core";

export interface Page<T> {
  items: T[];
  /** Absent on the last page, which is how a client knows to stop. */
  nextCursor?: string;
}

/**
 * Cuts a list into MCP pages.
 *
 * The cursor is the sort key of the last item already delivered rather than an
 * offset, so a catalogue that changes between pages shifts what comes next
 * instead of silently skipping or repeating entries. It is opaque to the
 * client, which is what the specification requires, and cheap to validate:
 * anything that does not decode is rejected rather than treated as page one.
 *
 * Items are re-sorted here rather than trusted to arrive sorted, because the
 * ordering has to agree with the comparison used to resume from a cursor and
 * the callers get their ordering from SQLite, which collates bytes rather than
 * UTF-16 code units.
 */
export function paginate<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  cursor: unknown,
  pageSize: number,
): Page<T> {
  const after = decodeCursor(cursor);
  const sorted = [...items].sort((left, right) =>
    keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0,
  );
  const start =
    after === null ? 0 : sorted.findIndex((item) => keyOf(item) > after);
  if (start < 0) return { items: [] };

  const page = sorted.slice(start, start + pageSize);
  const last = page[page.length - 1];
  if (last === undefined || start + page.length >= sorted.length) {
    return { items: page };
  }
  return { items: page, nextCursor: encodeCursor(keyOf(last)) };
}

function encodeCursor(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): string | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || cursor === "") {
    throw new GatewayError("INVALID_REQUEST", "cursor must be a non-empty string");
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  // base64url decoding never throws, so a bad cursor is caught by checking
  // that it round-trips rather than by trusting whatever bytes came back.
  if (encodeCursor(decoded) !== cursor) {
    throw new GatewayError("INVALID_REQUEST", "cursor is not a cursor this gateway issued");
  }
  return decoded;
}
