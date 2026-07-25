import {
  BackgroundWorker,
  DEFAULT_BACKGROUND_CONFIG,
  Gateway,
  type BackgroundWorkerConfig,
} from "@umg/gateway";

/**
 * Runs the periodic maintenance jobs against the same database the API serves
 * from, without listening on a port. Several replicas may run at once: every
 * job takes the same connection-scoped locks and compare-and-swap paths the
 * request path uses.
 */
function configFromEnv(env: NodeJS.ProcessEnv): BackgroundWorkerConfig {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const defaults = DEFAULT_BACKGROUND_CONFIG;
  return {
    refreshHorizonMs: read("WORKER_REFRESH_HORIZON_MS", defaults.refreshHorizonMs),
    refreshIntervalMs: read("WORKER_REFRESH_INTERVAL_MS", defaults.refreshIntervalMs),
    catalogueIntervalMs: read("WORKER_CATALOGUE_INTERVAL_MS", defaults.catalogueIntervalMs),
    sessionIdleMs: read("WORKER_SESSION_IDLE_MS", defaults.sessionIdleMs),
    reapIntervalMs: read("WORKER_REAP_INTERVAL_MS", defaults.reapIntervalMs),
    rewrapIntervalMs: read("WORKER_REWRAP_INTERVAL_MS", defaults.rewrapIntervalMs),
    batchSize: read("WORKER_BATCH_SIZE", defaults.batchSize),
  };
}

async function main(): Promise<void> {
  const gateway = new Gateway();
  const worker = new BackgroundWorker(gateway.services, configFromEnv(process.env));
  const logger = gateway.services.logger;

  // `--once` gives operators and cron schedulers a single deterministic pass.
  if (process.argv.includes("--once")) {
    for (const report of await worker.runOnce()) {
      logger.info("Background job finished", { ...report });
    }
    await gateway.close();
    return;
  }

  worker.start();
  const shutdown = (signal: string): void => {
    logger.info("Shutting down the background worker", { signal });
    worker.stop();
    void gateway.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
