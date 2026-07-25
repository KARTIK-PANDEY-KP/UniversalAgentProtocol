import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { clientById, type ConfigLocation, type PathContext } from "./clients.js";
import { parseConfigDocument, type GatewayEntrySpec } from "./config-file.js";
import { loadConfigs, type LoadedConfig } from "./discovery.js";
import type { BackupSet } from "./backup.js";

export interface FileChange {
  path: string;
  clientId: string;
  clientLabel: string;
  action: "create" | "update";
  contents: string;
  summary: string;
}

export interface SkippedLocation {
  location: ConfigLocation;
  reason: string;
}

export interface Plan {
  changes: FileChange[];
  skipped: SkippedLocation[];
}

export interface InstallOptions {
  gatewayMcpUrl: string;
  entryName: string;
  apiKey: string;
  apiKeyEnvVar: string;
  /** Write the key itself instead of a reference to an environment variable. */
  inlineKey: boolean;
  clientIds?: string[];
}

/**
 * Adds the gateway to every client config that can hold it. A client that
 * cannot dereference an environment variable is skipped unless the user has
 * explicitly accepted writing the key to disk.
 */
export async function planInstall(
  context: PathContext,
  options: InstallOptions,
): Promise<Plan> {
  const configs = await loadConfigs(context, options.clientIds ?? []);
  const changes: FileChange[] = [];
  const skipped: SkippedLocation[] = [];

  for (const config of configs) {
    const { location } = config;
    if (!config.exists && !location.creatable) {
      skipped.push({ location, reason: "no configuration file for this client" });
      continue;
    }
    if (config.exists && config.error) {
      skipped.push({ location, reason: `could not be parsed: ${config.error}` });
      continue;
    }
    const client = clientById(location.clientId);
    if (!client) continue;

    const useEnv = !options.inlineKey && client.envReference !== null;
    if (!useEnv && !options.inlineKey) {
      skipped.push({
        location,
        reason:
          `${location.clientLabel} cannot read an environment variable, so the ` +
          "gateway key would be stored in plain text; re-run with --inline-key to allow it",
      });
      continue;
    }
    if (!useEnv && options.apiKey === "") {
      skipped.push({ location, reason: "no gateway key to write" });
      continue;
    }

    const reference = useEnv
      ? (client.envReference?.(options.apiKeyEnvVar) ?? options.apiKeyEnvVar)
      : options.apiKey;
    const spec: GatewayEntrySpec = {
      name: options.entryName,
      url: options.gatewayMcpUrl,
      authorization: `Bearer ${reference}`,
      bearerTokenEnvVar: useEnv ? options.apiKeyEnvVar : null,
      bearerToken: useEnv ? null : options.apiKey,
    };

    const document = config.document ?? parseConfigDocument(location.path, location.format, "");
    const before = document.serialize();
    document.upsertGateway(spec);
    const after = document.serialize();
    if (config.exists && after === before) continue;

    changes.push({
      path: location.path,
      clientId: location.clientId,
      clientLabel: location.clientLabel,
      action: config.exists ? "update" : "create",
      contents: after,
      summary: `add MCP server "${options.entryName}" pointing at ${options.gatewayMcpUrl}`,
    });
  }

  return { changes, skipped };
}

export interface PruneOptions {
  /** Canonical URLs the gateway now serves; nothing else is touched. */
  migratedUrls: Set<string>;
  /** Canonicalizes a raw URL the same way the gateway does. */
  canonicalize(url: string): string | null;
  /** Never remove the gateway's own entry. */
  entryName: string;
  clientIds?: string[];
}

/**
 * Removes the direct upstream entries the gateway has taken over. Only servers
 * the gateway is actually serving are removed, so a connection that never
 * finished its authorization keeps working the way it did before.
 */
export async function planPrune(
  context: PathContext,
  options: PruneOptions,
): Promise<Plan> {
  const configs = await loadConfigs(context, options.clientIds ?? []);
  return prunePlanFor(configs, options);
}

export function prunePlanFor(configs: LoadedConfig[], options: PruneOptions): Plan {
  const changes: FileChange[] = [];
  const skipped: SkippedLocation[] = [];

  for (const config of configs) {
    if (!config.exists) continue;
    if (config.error || !config.document) {
      skipped.push({
        location: config.location,
        reason: `could not be parsed: ${config.error ?? "unknown error"}`,
      });
      continue;
    }
    const removable = config.remote.filter((entry) => {
      if (entry.name === options.entryName) return false;
      const canonical = options.canonicalize(entry.url);
      return canonical !== null && options.migratedUrls.has(canonical);
    });
    if (removable.length === 0) continue;

    const document = config.document;
    for (const entry of removable) {
      document.removeServer({ name: entry.name, container: entry.container });
    }
    changes.push({
      path: config.location.path,
      clientId: config.location.clientId,
      clientLabel: config.location.clientLabel,
      action: "update",
      contents: document.serialize(),
      summary: `remove ${removable.map((entry) => `"${entry.name}"`).join(", ")}`,
    });
  }

  return { changes, skipped };
}

/** Writes a plan to disk, capturing the previous contents first. */
export async function applyPlan(plan: Plan, backups: BackupSet): Promise<void> {
  for (const change of plan.changes) {
    await backups.capture(change.path);
    await mkdir(dirname(change.path), { recursive: true });
    await writeFile(change.path, change.contents, "utf8");
  }
}
