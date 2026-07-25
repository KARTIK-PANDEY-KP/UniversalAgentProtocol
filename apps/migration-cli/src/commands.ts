import { canonicalizeUrl } from "@umg/security";

import { BackupSet, listBackups, restoreBackup } from "./backup.js";
import type { PathContext } from "./clients.js";
import { discover, type DiscoveryResult } from "./discovery.js";
import type { GatewayControlPlane, ImportItem } from "./gateway-client.js";
import {
  applyPlan,
  planInstall,
  planPrune,
  type InstallOptions,
  type Plan,
} from "./plan.js";

export interface Output {
  line(text: string): void;
  json(value: unknown): void;
}

export interface CliContext {
  paths: PathContext;
  out: Output;
  stateDir: string;
  json: boolean;
  allowHttp: boolean;
  clientIds: string[];
  entryName: string;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_NEEDS_INPUT = 2;

/** Statuses that mean the gateway can serve the upstream right now. */
const SERVING = new Set(["CONNECTED", "CONNECTED_NON_REFRESHABLE", "DEGRADED"]);

export async function discoverCommand(
  context: CliContext,
  gatewayMcpUrl: string | null,
): Promise<number> {
  const result = await runDiscovery(context, gatewayMcpUrl);
  if (context.json) {
    context.out.json(toDiscoveryJson(result));
    return EXIT_OK;
  }
  renderDiscovery(context, result);
  return EXIT_OK;
}

export async function importCommand(
  context: CliContext,
  gateway: GatewayControlPlane,
): Promise<number> {
  const discovery = await runDiscovery(context, gateway.mcpUrl);
  if (discovery.servers.length === 0) {
    context.out.line("No remote MCP servers were found in your client configurations.");
    return EXIT_OK;
  }

  const items: ImportItem[] = discovery.servers.map((server) => ({
    url: server.canonicalUrl,
    alias: server.suggestedAlias,
  }));
  const outcomes = await gateway.importServers(items);

  if (context.json) {
    context.out.json({ imported: outcomes });
    return outcomes.some((outcome) => outcome.status === "FAILED") ? EXIT_FAILED : EXIT_OK;
  }

  context.out.line(`Imported ${outcomes.length} remote MCP server(s) into the gateway.`);
  const pending: string[] = [];
  for (const outcome of outcomes) {
    context.out.line(`  ${outcome.status.padEnd(24)} ${outcome.url}`);
    if (outcome.message) context.out.line(`      ${outcome.message}`);
    const connect = outcome.connect_url;
    if (connect) pending.push(`  ${outcome.alias ?? outcome.url}: ${connect}`);
  }
  if (pending.length > 0) {
    context.out.line("");
    context.out.line("Authorize each protected server once, in a browser:");
    for (const line of pending) context.out.line(line);
    context.out.line("");
    context.out.line("Then run `umg-migrate status` to confirm, and `umg-migrate install`.");
  }
  return outcomes.some((outcome) => outcome.status === "FAILED") ? EXIT_FAILED : EXIT_OK;
}

export async function statusCommand(
  context: CliContext,
  gateway: GatewayControlPlane,
  options: { failOnPending?: boolean } = {},
): Promise<number> {
  const connections = await gateway.connections();
  const pending = connections.filter((connection) => !SERVING.has(connection.status));

  if (context.json) {
    context.out.json({ connections });
  } else if (connections.length === 0) {
    context.out.line("The gateway has no upstream connections yet. Run `umg-migrate import`.");
  } else {
    for (const connection of connections) {
      const tools = `${connection.tool_count} tool${connection.tool_count === 1 ? "" : "s"}`;
      context.out.line(
        `  ${connection.status.padEnd(24)} ${connection.alias.padEnd(20)} ${tools.padEnd(10)} ${connection.mcp_url}`,
      );
      if (connection.connect_url) {
        context.out.line(`      authorize: ${connection.connect_url}`);
      }
      if (connection.last_error) context.out.line(`      last error: ${connection.last_error}`);
    }
  }
  return options.failOnPending && pending.length > 0 ? EXIT_FAILED : EXIT_OK;
}

export async function installCommand(
  context: CliContext,
  options: InstallOptions & { dryRun: boolean },
): Promise<number> {
  const plan = await planInstall(context.paths, options);
  return writePlan(context, plan, "install", options.dryRun);
}

export async function pruneCommand(
  context: CliContext,
  gateway: GatewayControlPlane,
  options: { dryRun: boolean; yes: boolean },
): Promise<number> {
  const connections = await gateway.connections();
  const serving = connections.filter((connection) => SERVING.has(connection.status));
  const migrated = new Set(
    serving
      .map((connection) => canonicalize(connection.mcp_url, context.allowHttp))
      .filter((url): url is string => url !== null),
  );
  if (migrated.size === 0) {
    context.out.line(
      "No upstream connection is being served yet, so nothing can safely be removed.",
    );
    return EXIT_OK;
  }

  const plan = await planPrune(context.paths, {
    migratedUrls: migrated,
    canonicalize: (url) => canonicalize(url, context.allowHttp),
    entryName: context.entryName,
    ...(context.clientIds.length > 0 ? { clientIds: context.clientIds } : {}),
  });

  if (plan.changes.length > 0 && !options.yes && !options.dryRun) {
    renderPlan(context, plan, "prune");
    context.out.line("");
    context.out.line("Re-run with --yes to apply, or --dry-run to see the resulting files.");
    return EXIT_NEEDS_INPUT;
  }
  return writePlan(context, plan, "prune", options.dryRun);
}

export async function rollbackCommand(
  context: CliContext,
  options: { id?: string } = {},
): Promise<number> {
  const result = await restoreBackup(context.stateDir, options.id);
  if (!result) {
    context.out.line("There is nothing to roll back.");
    return EXIT_OK;
  }
  if (context.json) {
    context.out.json(result);
    return EXIT_OK;
  }
  context.out.line(`Restored backup ${result.manifest.id} (${result.manifest.command}).`);
  for (const path of result.restored) context.out.line(`  restored ${path}`);
  for (const path of result.removed) context.out.line(`  removed  ${path}`);
  return EXIT_OK;
}

export async function backupsCommand(context: CliContext): Promise<number> {
  const manifests = await listBackups(context.stateDir);
  if (context.json) {
    context.out.json({ backups: manifests });
    return EXIT_OK;
  }
  if (manifests.length === 0) {
    context.out.line("No backups have been taken yet.");
    return EXIT_OK;
  }
  for (const manifest of manifests) {
    context.out.line(
      `  ${manifest.id}  ${manifest.command.padEnd(10)} ${manifest.entries.length} file(s)`,
    );
  }
  return EXIT_OK;
}

async function runDiscovery(
  context: CliContext,
  gatewayMcpUrl: string | null,
): Promise<DiscoveryResult> {
  return discover(context.paths, {
    allowHttp: context.allowHttp,
    ...(context.clientIds.length > 0 ? { clientIds: context.clientIds } : {}),
    ...(gatewayMcpUrl ? { gatewayMcpUrl } : {}),
  });
}

async function writePlan(
  context: CliContext,
  plan: Plan,
  command: string,
  dryRun: boolean,
): Promise<number> {
  if (context.json) {
    context.out.json({
      dry_run: dryRun,
      changes: plan.changes.map((change) => ({
        path: change.path,
        client: change.clientId,
        action: change.action,
        summary: change.summary,
      })),
      skipped: plan.skipped.map((entry) => ({
        path: entry.location.path,
        client: entry.location.clientId,
        reason: entry.reason,
      })),
    });
  } else {
    renderPlan(context, plan, command);
  }
  if (dryRun || plan.changes.length === 0) return EXIT_OK;

  const backups = await BackupSet.open(context.stateDir, command);
  await applyPlan(plan, backups);
  const manifest = await backups.commit();
  if (manifest && !context.json) {
    context.out.line("");
    context.out.line(`Saved a backup as ${manifest.id}; undo with \`umg-migrate rollback\`.`);
  }
  return EXIT_OK;
}

function renderPlan(context: CliContext, plan: Plan, command: string): void {
  if (plan.changes.length === 0) {
    context.out.line(`Nothing to ${command}: every client configuration is already correct.`);
  }
  for (const change of plan.changes) {
    context.out.line(`  ${change.action.padEnd(7)} ${change.path}`);
    context.out.line(`          ${change.clientLabel}: ${change.summary}`);
  }
  for (const entry of plan.skipped) {
    context.out.line(`  skipped ${entry.location.path}`);
    context.out.line(`          ${entry.reason}`);
  }
}

function renderDiscovery(context: CliContext, result: DiscoveryResult): void {
  const found = result.configs.filter((config) => config.exists);
  if (found.length === 0) {
    context.out.line("No MCP client configuration files were found.");
    return;
  }
  context.out.line("Configuration files:");
  for (const config of found) {
    const detail = config.error
      ? `unreadable (${config.error})`
      : `${config.remote.length} remote, ${config.local.length} local`;
    context.out.line(`  ${config.location.clientLabel.padEnd(16)} ${config.location.path}`);
    context.out.line(`  ${" ".repeat(16)} ${detail}`);
  }

  context.out.line("");
  if (result.servers.length === 0) {
    context.out.line("No remote MCP servers to import.");
  } else {
    context.out.line(`Remote MCP servers to import (${result.servers.length}):`);
    for (const server of result.servers) {
      const clients = [...new Set(server.sources.map((source) => source.clientLabel))].join(", ");
      context.out.line(`  ${server.canonicalUrl}`);
      context.out.line(`      configured in ${clients} as "${server.suggestedAlias}"`);
    }
  }

  const stdio = result.skipped.filter((entry) => entry.reason === "stdio");
  if (stdio.length > 0) {
    context.out.line("");
    context.out.line(
      `Skipping ${stdio.length} local stdio server(s); a hosted gateway cannot launch them.`,
    );
    for (const entry of stdio) {
      context.out.line(`  ${entry.name} (${entry.clientLabel})`);
    }
  }
}

function toDiscoveryJson(result: DiscoveryResult): Record<string, unknown> {
  return {
    configs: result.configs
      .filter((config) => config.exists)
      .map((config) => ({
        client: config.location.clientId,
        path: config.location.path,
        error: config.error,
        remote: config.remote.length,
        local: config.local.length,
      })),
    servers: result.servers,
    skipped: result.skipped,
  };
}

function canonicalize(url: string, allowHttp: boolean): string | null {
  try {
    return canonicalizeUrl(url, { allowHttp });
  } catch {
    return null;
  }
}
