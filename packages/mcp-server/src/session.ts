import {
  GatewayError,
  JSONRPC_VERSION,
  isJsonRpcFailure,
  isRecord,
  newId,
  toJsonObject,
  type JsonObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpLogLevel,
  type RequestId,
} from "@uap/core";

import type { EventStreamWriter } from "./http.js";

export interface DownstreamSessionHandle {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly clientLabel: string;
  readonly roles: string[];
  readonly protocolVersion: string;
  readonly capabilities: McpClientCapabilities;
  /** Least severe log message the client asked to receive; null means all. */
  readonly logLevel: McpLogLevel | null;
  setLogLevel(level: McpLogLevel): void;
  /** Pushes a notification to the client's event stream when one is open. */
  sendNotification(notification: JsonRpcNotification): void;
  /**
   * Issues a server-to-client request such as `sampling/createMessage`. Fails
   * when the client never opened a stream or did not advertise the capability.
   */
  sendRequest(
    method: string,
    params: JsonObject,
    timeoutMs?: number,
  ): Promise<JsonObject>;
  close(): void;
}

interface PendingServerRequest {
  resolve(result: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface HistoryEntry {
  id: number;
  message: JsonRpcNotification | JsonRpcRequest;
  /** False while no stream has carried it, so the next one to open gets it. */
  delivered: boolean;
}

/**
 * How many messages a session keeps for replay. A client that was away long
 * enough to miss more than this cannot be caught up exactly; it will still see
 * the catalogue change notifications that matter, because the gateway re-sends
 * one per change rather than a diff.
 */
const HISTORY_LIMIT = 256;

export class DownstreamSession implements DownstreamSessionHandle {
  readonly id: string;
  protocolVersion: string;
  capabilities: McpClientCapabilities = {};
  logLevel: McpLogLevel | null = null;
  lastSeenAt: number;

  /** Standalone streams the client opened with GET. */
  private streams = new Set<EventStreamWriter>();
  /**
   * Streams opened to answer a POST, newest last. MCP asks a server to put a
   * request it raises on the stream carrying the request that caused it, and
   * many clients never open a standalone stream at all, so without these a
   * `sampling/createMessage` from an upstream would have nowhere to go.
   */
  private readonly requestStreams: EventStreamWriter[] = [];
  private readonly history: HistoryEntry[] = [];
  private nextEventId = 1;
  private readonly pending = new Map<RequestId, PendingServerRequest>();
  /** Requests the client is still waiting on, so it can cancel one by id. */
  private readonly inFlight = new Map<RequestId, AbortController>();
  private nextRequestId = 1;
  private closedFlag = false;

  constructor(
    readonly tenantId: string,
    readonly userId: string,
    readonly clientLabel: string,
    readonly roles: string[],
    protocolVersion: string,
    now: number,
    id?: string,
  ) {
    this.id = id ?? newId("dsess");
    this.protocolVersion = protocolVersion;
    this.lastSeenAt = now;
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  setLogLevel(level: McpLogLevel): void {
    this.logLevel = level;
  }

  /**
   * Attaches a client's event stream. `lastEventId` is the `Last-Event-ID`
   * header of a reconnecting client: everything after it is replayed, which is
   * what makes the ids on the wire worth attaching. Without one, only messages
   * no stream has carried yet are sent, so a fresh client is not shown the
   * history of a session it is only now joining.
   */
  attachStream(stream: EventStreamWriter, lastEventId?: number): void {
    this.streams.add(stream);
    const replay =
      lastEventId === undefined
        ? this.history.filter((entry) => !entry.delivered)
        : this.history.filter((entry) => entry.id > lastEventId);
    for (const entry of replay) {
      stream.write(entry.message, entry.id);
      entry.delivered = true;
    }
  }

  detachStream(stream: EventStreamWriter): void {
    this.streams.delete(stream);
  }

  /** Registers the stream answering one POST for the life of that request. */
  beginRequestStream(stream: EventStreamWriter): void {
    this.requestStreams.push(stream);
  }

  endRequestStream(stream: EventStreamWriter): void {
    const at = this.requestStreams.lastIndexOf(stream);
    if (at >= 0) this.requestStreams.splice(at, 1);
  }

  hasStream(): boolean {
    return this.liveRequestStream() !== undefined || this.liveStream() !== undefined;
  }

  sendNotification(notification: JsonRpcNotification): void {
    this.deliver(notification);
  }

  private liveRequestStream(): EventStreamWriter | undefined {
    for (let index = this.requestStreams.length - 1; index >= 0; index -= 1) {
      const stream = this.requestStreams[index];
      if (stream && !stream.isClosed) return stream;
    }
    return undefined;
  }

  /**
   * The newest standalone stream. A client that reconnected before its old
   * stream was reaped is reading the new one, and the old one is about to be
   * swept.
   */
  private liveStream(): EventStreamWriter | undefined {
    let newest: EventStreamWriter | undefined;
    for (const stream of this.streams) {
      if (!stream.isClosed) newest = stream;
    }
    return newest;
  }

  /**
   * Records a message against the session's event ids and writes it to exactly
   * one stream: MCP forbids putting the same message on several, since a
   * client reading two would act on it twice. With nothing open it stays in
   * the history undelivered, so a client that reconnects still learns about
   * catalogue changes.
   */
  private deliver(
    message: JsonRpcNotification | JsonRpcRequest,
    preferred?: EventStreamWriter,
  ): void {
    const entry: HistoryEntry = {
      id: this.nextEventId,
      message,
      delivered: false,
    };
    this.nextEventId += 1;
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    const target = preferred?.isClosed === false ? preferred : this.liveStream();
    if (!target) return;
    entry.delivered = true;
    target.write(message, entry.id);
  }

  async sendRequest(
    method: string,
    params: JsonObject,
    timeoutMs = 60_000,
  ): Promise<JsonObject> {
    if (!this.hasStream()) {
      throw new GatewayError(
        "UPSTREAM_PROTOCOL_ERROR",
        "The downstream client has no open stream to receive server requests",
      );
    }
    const id: RequestId = `srv-${this.nextRequestId}`;
    this.nextRequestId += 1;
    const request: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
    };
    const result = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GatewayError(
            "UPSTREAM_PROTOCOL_ERROR",
            `The downstream client did not answer ${method} in time`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.deliver(request, this.liveRequestStream());
    return result;
  }

  beginRequest(id: RequestId, controller: AbortController): void {
    this.inFlight.set(id, controller);
  }

  endRequest(id: RequestId): void {
    this.inFlight.delete(id);
  }

  /**
   * Aborts an in-flight request the client asked to cancel. Returns false when
   * the request already finished, which is the race MCP explicitly tolerates:
   * the cancellation is simply ignored.
   */
  cancelRequest(id: RequestId): boolean {
    const controller = this.inFlight.get(id);
    if (!controller) return false;
    this.inFlight.delete(id);
    controller.abort();
    return true;
  }

  /** Routes a JSON-RPC response the client posted back for a server request. */
  resolveResponse(response: JsonRpcResponse): boolean {
    const id = "id" in response ? response.id : null;
    if (id === null) return false;
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (isJsonRpcFailure(response)) {
      pending.reject(
        new GatewayError("UPSTREAM_PROTOCOL_ERROR", response.error.message),
      );
    } else {
      pending.resolve(isRecord(response.result) ? toJsonObject(response.result) : {});
    }
    return true;
  }

  close(): void {
    this.closedFlag = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GatewayError("NOT_FOUND", "Session closed"));
    }
    this.pending.clear();
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    for (const stream of this.requestStreams) stream.end();
    this.requestStreams.length = 0;
  }
}
