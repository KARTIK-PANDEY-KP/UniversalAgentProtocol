import {
  newId,
  sha256Hex,
  stableStringify,
  type AuditEvent,
  type Clock,
  type JsonObject,
} from "@umg/core";
import type { Logger } from "@umg/observability";
import type { GatewayStore } from "@umg/storage";

export interface AuditInput {
  tenantId: string;
  userId?: string | null;
  downstreamSessionId?: string | null;
  connectionId?: string | null;
  toolId?: string | null;
  operation: string;
  input?: unknown;
  resultStatus: AuditEvent["resultStatus"];
  durationMs?: number | null;
  providerRequestId?: string | null;
  detail?: JsonObject | null;
}

/**
 * Records what happened without recording what was said. Tool arguments are
 * reduced to a hash so an audit trail never becomes a second copy of the
 * user's data.
 */
export class AuditService {
  constructor(
    private readonly store: GatewayStore,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async record(input: AuditInput): Promise<void> {
    const event: AuditEvent = {
      id: newId("aud"),
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      downstreamSessionId: input.downstreamSessionId ?? null,
      connectionId: input.connectionId ?? null,
      toolId: input.toolId ?? null,
      operation: input.operation,
      inputHash:
        input.input === undefined ? null : sha256Hex(stableStringify(input.input)),
      resultStatus: input.resultStatus,
      durationMs: input.durationMs ?? null,
      providerRequestId: input.providerRequestId ?? null,
      detailJson: input.detail ?? null,
      createdAt: this.clock.now(),
    };
    try {
      await this.store.audit.append(event);
    } catch (error) {
      this.logger.error("Failed to persist audit event", {
        operation: input.operation,
        error: (error as Error).message,
      });
    }
  }
}
