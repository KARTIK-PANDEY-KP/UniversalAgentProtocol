import { readFile } from "node:fs/promises";

import { canonicalizeUrl } from "@umg/security";

import { candidateLocations, type ConfigLocation, type PathContext } from "./clients.js";
import {
  parseConfigDocument,
  type ConfigDocument,
  type LocalServerEntry,
  type RemoteServerEntry,
} from "./config-file.js";

export interface LoadedConfig {
  location: ConfigLocation;
  exists: boolean;
  /** Set when the file exists but could not be parsed. */
  error: string | null;
  document: ConfigDocument | null;
  remote: RemoteServerEntry[];
  local: LocalServerEntry[];
}

export interface ServerSource {
  clientId: string;
  clientLabel: string;
  path: string;
  name: string;
  rawUrl: string;
}

export interface DiscoveredServer {
  canonicalUrl: string;
  /** The name to propose as the gateway alias: whatever the user chose first. */
  suggestedAlias: string;
  sources: ServerSource[];
}

export interface DiscoveryOptions {
  clientIds?: string[];
  allowHttp?: boolean;
  /** The gateway's own MCP endpoint, so it is never imported into itself. */
  gatewayMcpUrl?: string;
}

export interface DiscoveryResult {
  configs: LoadedConfig[];
  servers: DiscoveredServer[];
  skipped: (ServerSource & { reason: "stdio" | "gateway" | "unusable-url" })[];
}

export async function loadConfigs(
  context: PathContext,
  clientIds: string[] = [],
): Promise<LoadedConfig[]> {
  const locations = candidateLocations(context, clientIds);
  return Promise.all(locations.map((location) => loadConfig(location)));
}

export async function loadConfig(location: ConfigLocation): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await readFile(location.path, "utf8");
  } catch {
    return { location, exists: false, error: null, document: null, remote: [], local: [] };
  }
  try {
    const document = parseConfigDocument(location.path, location.format, raw);
    const { remote, local } = document.servers();
    return { location, exists: true, error: null, document, remote, local };
  } catch (error) {
    return {
      location,
      exists: true,
      error: (error as Error).message,
      document: null,
      remote: [],
      local: [],
    };
  }
}

/**
 * Collects every remote MCP server the user has already configured, keyed by
 * canonical URL so the same server reached from three applications becomes one
 * upstream connection. Local stdio servers are reported but never imported:
 * a hosted gateway cannot launch a program on the user's machine.
 */
export async function discover(
  context: PathContext,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const policy = { allowHttp: options.allowHttp ?? false };
  const configs = await loadConfigs(context, options.clientIds ?? []);
  const gatewayUrl = safeCanonical(options.gatewayMcpUrl ?? "", policy);

  const byUrl = new Map<string, DiscoveredServer>();
  const skipped: DiscoveryResult["skipped"] = [];

  for (const config of configs) {
    const describe = (name: string, rawUrl: string): ServerSource => ({
      clientId: config.location.clientId,
      clientLabel: config.location.clientLabel,
      path: config.location.path,
      name,
      rawUrl,
    });

    for (const entry of config.local) {
      skipped.push({ ...describe(entry.name, entry.command), reason: "stdio" });
    }

    for (const entry of config.remote) {
      const source = describe(entry.name, entry.url);
      const canonical = safeCanonical(entry.url, policy);
      if (!canonical) {
        skipped.push({ ...source, reason: "unusable-url" });
        continue;
      }
      if (gatewayUrl && canonical === gatewayUrl) {
        skipped.push({ ...source, reason: "gateway" });
        continue;
      }
      const existing = byUrl.get(canonical);
      if (existing) {
        existing.sources.push(source);
        continue;
      }
      byUrl.set(canonical, {
        canonicalUrl: canonical,
        suggestedAlias: entry.name,
        sources: [source],
      });
    }
  }

  return { configs, servers: [...byUrl.values()], skipped };
}

function safeCanonical(url: string, policy: { allowHttp: boolean }): string | null {
  if (url.trim() === "") return null;
  try {
    return canonicalizeUrl(url, policy);
  } catch {
    return null;
  }
}
