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
  type RequestId,
} from "@umg/core";

import type { EventStreamWriter } from "./http.js";

export interface DownstreamSessionHandle {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly clientLabel: string;
  readonly roles: string[];
  readonly protocolVersion: string;
  readonly capabilities: McpClientCapabilities;
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

export class DownstreamSession implements DownstreamSessionHandle {
  readonly id: string;
  protocolVersion: string;
  capabilities: McpClientCapabilities = {};
  lastSeenAt: number;

  private streams = new Set<EventStreamWriter>();
  private readonly queued: JsonRpcNotification[] = [];
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

  attachStream(stream: EventStreamWriter): void {
    this.streams.add(stream);
    while (this.queued.length > 0) {
      const message = this.queued.shift();
      if (message) stream.write(message);
    }
  }

  detachStream(stream: EventStreamWriter): void {
    this.streams.delete(stream);
  }

  hasStream(): boolean {
    for (const stream of this.streams) {
      if (!stream.isClosed) return true;
    }
    return false;
  }

  sendNotification(notification: JsonRpcNotification): void {
    const live = [...this.streams].filter((stream) => !stream.isClosed);
    if (live.length === 0) {
      // Hold a bounded backlog so a client that reconnects still learns about
      // catalogue changes.
      if (this.queued.length < 100) this.queued.push(notification);
      return;
    }
    for (const stream of live) stream.write(notification);
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
    for (const stream of this.streams) stream.write(request);
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
  }
}
