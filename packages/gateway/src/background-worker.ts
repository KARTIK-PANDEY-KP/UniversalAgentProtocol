import { clampText, type UpstreamConnection } from "@umg/core";
import { Metric } from "@umg/observability";

import type { GatewayServices } from "./gateway.js";

export interface BackgroundWorkerConfig {
  /** Refresh an access token this long before it would expire. */
  refreshHorizonMs: number;
  refreshIntervalMs: number;
  /** Rediscover an upstream catalogue at most this often. */
  catalogueIntervalMs: number;
  /** Close downstream and upstream MCP sessions idle for longer than this. */
  sessionIdleMs: number;
  reapIntervalMs: number;
  /** Re-encrypt credentials still sealed under a retired key. */
  rewrapIntervalMs: number;
  /** Connections processed per pass, so one tenant cannot starve the rest. */
  batchSize: number;
}

export const DEFAULT_BACKGROUND_CONFIG: BackgroundWorkerConfig = {
  refreshHorizonMs: 5 * 60_000,
  refreshIntervalMs: 60_000,
  catalogueIntervalMs: 15 * 60_000,
  sessionIdleMs: 30 * 60_000,
  reapIntervalMs: 5 * 60_000,
  rewrapIntervalMs: 60 * 60_000,
  batchSize: 100,
};

export interface JobReport {
  name: string;
  processed: number;
  failed: number;
  durationMs: number;
}

/**
 * Keeps connections usable between requests. Every job is idempotent and
 * safe to run alongside live traffic and alongside another worker: the token
 * refresh goes through the same connection-scoped lock and compare-and-swap
 * as an on-demand refresh, so a scheduled run and a user request can never
 * rotate a refresh token twice.
 */
export class BackgroundWorker {
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly services: GatewayServices,
    private readonly config: BackgroundWorkerConfig = DEFAULT_BACKGROUND_CONFIG,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.config.refreshIntervalMs, () => this.refreshExpiringTokens());
    this.schedule(this.config.catalogueIntervalMs, () => this.resyncCatalogues());
    this.schedule(this.config.reapIntervalMs, () => this.reapSessions());
    this.schedule(this.config.rewrapIntervalMs, () => this.rewrapCredentials());
    this.services.logger.info("Background worker started", {
      refreshIntervalMs: this.config.refreshIntervalMs,
      catalogueIntervalMs: this.config.catalogueIntervalMs,
    });
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.running = false;
  }

  /** Runs every job once. Used by the worker entry point and by tests. */
  async runOnce(): Promise<JobReport[]> {
    return [
      await this.refreshExpiringTokens(),
      await this.resyncCatalogues(),
      await this.reapSessions(),
      await this.rewrapCredentials(),
    ];
  }

  /**
   * Renews access tokens that are close to expiry so an interactive tool call
   * does not have to wait for the authorization server.
   */
  async refreshExpiringTokens(): Promise<JobReport> {
    return this.job("refresh_tokens", async (report) => {
      const deadline = this.services.clock.now() + this.config.refreshHorizonMs;
      for (const connection of await this.dueForRefresh(deadline)) {
        report.processed += 1;
        try {
          await this.services.tokenManager.getValidAccessToken(
            { tenantId: connection.tenantId, connectionId: connection.id },
            { minRemainingMs: this.config.refreshHorizonMs },
          );
        } catch (error) {
          report.failed += 1;
          // The token manager has already recorded the reason on the
          // connection; a failure here must not stop the remaining ones.
          this.services.logger.warn("Scheduled token refresh failed", {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            error: clampText((error as Error).message, 200),
          });
        }
      }
    });
  }

  /** Picks up tools, resources and prompts an upstream added or withdrew. */
  async resyncCatalogues(): Promise<JobReport> {
    return this.job("resync_catalogues", async (report) => {
      const stale = this.services.clock.now() - this.config.catalogueIntervalMs;
      const connections = (await this.services.store.connections.listAll())
        .filter((connection) => isOnline(connection))
        .filter((connection) => (connection.lastSuccessAt ?? 0) <= stale)
        .slice(0, this.config.batchSize);

      for (const connection of connections) {
        report.processed += 1;
        try {
          await this.services.connections.syncCatalogue(connection);
        } catch {
          // syncCatalogue already degraded the connection and logged why.
          report.failed += 1;
        }
      }
    });
  }

  /** Releases idle sessions and consumes expired authorization transactions. */
  async reapSessions(): Promise<JobReport> {
    return this.job("reap_sessions", async (report) => {
      const now = this.services.clock.now();
      const downstream = await this.services.northbound.sweep(
        now,
        this.config.sessionIdleMs,
      );
      const upstream = await this.services.upstreamSessions.sweep(
        this.config.sessionIdleMs,
      );
      const transactions = await this.services.store.transactions.purgeExpired(now);
      // Rate limit buckets are per tenant and would otherwise outlive the
      // tenants that created them.
      const buckets =
        this.services.apiLimiter.sweep() + this.services.toolCallLimiter.sweep();
      report.processed = downstream + upstream + transactions + buckets;
      for (const [scope, count] of [
        ["downstream", downstream],
        ["upstream", upstream],
      ] as const) {
        for (let index = 0; index < count; index += 1) {
          this.services.metrics.counter(Metric.SessionReaped, { scope });
        }
      }
      this.services.logger.debug("Reaped idle state", {
        downstream,
        upstream,
        transactions,
        buckets,
      });
    });
  }

  /**
   * Moves ciphertext onto the active encryption key after a key rotation. The
   * plaintext never leaves the process and the token version is untouched, so
   * a concurrent refresh still wins the compare-and-swap it expects.
   */
  async rewrapCredentials(): Promise<JobReport> {
    return this.job("rewrap_credentials", async (report) => {
      const { store, vault } = this.services;
      for (const connection of await store.connections.listAll()) {
        const patch: Partial<UpstreamConnection> = {};
        for (const field of [
          "accessTokenEncrypted",
          "refreshTokenEncrypted",
          "staticHeadersEncrypted",
        ] as const) {
          const ciphertext = connection[field];
          if (!ciphertext || !vault.needsRewrap(ciphertext)) continue;
          patch[field] = await vault.rewrap(
            { tenantId: connection.tenantId, purpose: purposeOf(field) },
            ciphertext,
          );
        }
        if (Object.keys(patch).length === 0) continue;
        report.processed += 1;
        try {
          await store.connections.update(connection.id, patch);
          this.services.metrics.counter(Metric.CredentialRewrapped, {
            kind: "connection",
          });
        } catch (error) {
          report.failed += 1;
          this.services.logger.warn("Credential rewrap failed", {
            connectionId: connection.id,
            error: clampText((error as Error).message, 200),
          });
        }
      }
    });
  }

  private async dueForRefresh(deadline: number): Promise<UpstreamConnection[]> {
    const connections = await this.services.store.connections.listAll();
    return connections
      .filter(
        (connection) =>
          isOnline(connection) &&
          connection.refreshTokenEncrypted !== null &&
          connection.accessTokenExpiresAt !== null &&
          connection.accessTokenExpiresAt <= deadline,
      )
      .slice(0, this.config.batchSize);
  }

  private schedule(intervalMs: number, run: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      void run().catch((error: unknown) => {
        this.services.logger.error("Background job threw", {
          error: clampText((error as Error).message, 200),
        });
      });
    }, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  private async job(
    name: string,
    body: (report: JobReport) => Promise<void>,
  ): Promise<JobReport> {
    const started = this.services.clock.now();
    const report: JobReport = { name, processed: 0, failed: 0, durationMs: 0 };
    try {
      await body(report);
    } catch (error) {
      report.failed += 1;
      this.services.metrics.counter(Metric.BackgroundJobFailed, { job: name });
      this.services.logger.error("Background job failed", {
        job: name,
        error: clampText((error as Error).message, 200),
      });
    }
    report.durationMs = this.services.clock.now() - started;
    this.services.metrics.counter(Metric.BackgroundJobRun, { job: name });
    this.services.metrics.observe(Metric.BackgroundJobDuration, report.durationMs, {
      job: name,
    });
    return report;
  }
}

function isOnline(connection: UpstreamConnection): boolean {
  return (
    connection.status === "CONNECTED" ||
    connection.status === "CONNECTED_NON_REFRESHABLE" ||
    connection.status === "DEGRADED"
  );
}

function purposeOf(
  field: "accessTokenEncrypted" | "refreshTokenEncrypted" | "staticHeadersEncrypted",
): "access_token" | "refresh_token" | "static_headers" {
  switch (field) {
    case "accessTokenEncrypted":
      return "access_token";
    case "refreshTokenEncrypted":
      return "refresh_token";
    case "staticHeadersEncrypted":
      return "static_headers";
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}
