import { Gateway } from "@uap/gateway";

async function main(): Promise<void> {
  const gateway = new Gateway();
  const port = await gateway.listen();
  gateway.services.logger.info("Universal Agent Protocol Gateway started", {
    baseUrl: gateway.services.config.baseUrl,
    port,
    mcpEndpoint: `${gateway.services.config.baseUrl}/mcp`,
  });

  const shutdown = (signal: string): void => {
    gateway.services.logger.info("Shutting down", { signal });
    void gateway.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
