import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";

import { GatewayError, clampText } from "@uap/core";
import { Metric, type MetricsRegistry } from "@uap/observability";

import { classifyAddress, literalAddressOf, type IpDisposition } from "./ip-rules.js";
import { parseAbsoluteUrl } from "./url.js";

export interface SsrfPolicy {
  allowHttp: boolean;
  allowLoopback: boolean;
  allowPrivateNetworks: boolean;
  /** Host names an administrator has explicitly opted in to. */
  allowedHosts: string[];
  /** When non-empty, only these hosts may be contacted at all. */
  hostAllowlist: string[];
  maxRedirects: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

export const STRICT_SSRF_POLICY: SsrfPolicy = {
  allowHttp: false,
  allowLoopback: false,
  allowPrivateNetworks: false,
  allowedHosts: [],
  hostAllowlist: [],
  maxRedirects: 3,
  maxResponseBytes: 1_000_000,
  timeoutMs: 10_000,
};

export interface SafeRequestOptions {
  url: string | URL;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxResponseBytes?: number;
  followRedirects?: boolean;
  /** Accepted media types; the response is rejected when it matches none. */
  expectedContentTypes?: string[];
  /** Leaves the body unread so the caller can consume an event stream. */
  stream?: boolean;
  signal?: AbortSignal;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: Readable;
  text(): Promise<string>;
  json(): Promise<unknown>;
  discard(): void;
}

function dispositionAllowed(
  disposition: IpDisposition,
  policy: SsrfPolicy,
): boolean {
  switch (disposition) {
    case "PUBLIC":
      return true;
    case "LOOPBACK":
      return policy.allowLoopback;
    case "PRIVATE":
      return policy.allowPrivateNetworks;
    case "LINK_LOCAL":
    case "CLOUD_METADATA":
    case "RESERVED":
      return false;
    default: {
      const exhaustive: never = disposition;
      void exhaustive;
      return false;
    }
  }
}

class SsrfBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlocked";
  }
}

/**
 * Headers that authenticate the gateway to one origin and must never reach
 * another. An upstream that answers a request with a redirect chooses where
 * the next request goes; without this it would also choose who receives the
 * credential attached to it.
 */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "dpop",
  "mcp-session-id",
]);

function withoutCredentials(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const kept: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) kept[key] = value;
  }
  return kept;
}

/**
 * Performs outbound HTTP for every user-influenced URL the gateway touches:
 * MCP endpoints, protected resource metadata, authorization server metadata,
 * registration endpoints and token endpoints. Address validation happens
 * inside the connection `lookup` hook, so a name that resolves to a public
 * address during validation and to a private one at connect time is still
 * rejected.
 */
export class SafeFetcher {
  constructor(
    private readonly policy: SsrfPolicy,
    private readonly metrics?: MetricsRegistry,
  ) {}

  get ssrfPolicy(): SsrfPolicy {
    return this.policy;
  }

  withPolicy(overrides: Partial<SsrfPolicy>): SafeFetcher {
    return new SafeFetcher({ ...this.policy, ...overrides }, this.metrics);
  }

  async request(options: SafeRequestOptions): Promise<SafeResponse> {
    const follow = options.followRedirects !== false;
    const method = (options.method ?? "GET").toUpperCase();
    const redirectable = follow && (method === "GET" || method === "HEAD");

    let current = typeof options.url === "string" ? options.url : options.url.href;
    let headers = options.headers;
    let hop = 0;

    for (;;) {
      const response = await this.requestOnce(current, options, headers);
      const location = response.headers["location"];
      const isRedirect =
        response.status >= 300 && response.status < 400 && location !== undefined;

      // A caller that asked not to follow wants the 3xx itself, and a POST is
      // never replayed at a location the far end chose.
      if (!isRedirect || !redirectable) {
        this.assertContentType(response, options);
        return response;
      }
      if (hop >= this.policy.maxRedirects) {
        response.discard();
        throw new GatewayError("DISCOVERY_FAILED", `Too many redirects from ${current}`);
      }

      response.discard();
      const next = new URL(location, current);
      // Each hop is validated again by requestOnce; what it cannot recover is a
      // credential already sent, so the credential is dropped at the boundary.
      if (next.origin !== new URL(current).origin) headers = withoutCredentials(headers);
      current = next.href;
      hop += 1;
    }
  }

  async getJson(
    url: string,
    options: Omit<SafeRequestOptions, "url"> = {},
  ): Promise<{ value: unknown; response: SafeResponse }> {
    const response = await this.request({
      url,
      method: "GET",
      expectedContentTypes: options.expectedContentTypes ?? ["application/json"],
      ...options,
    });
    if (response.status !== 200) {
      response.discard();
      throw new GatewayError(
        "DISCOVERY_FAILED",
        `Metadata endpoint returned HTTP ${response.status}`,
        { data: { url, status: response.status } },
      );
    }
    return { value: await response.json(), response };
  }

  private assertContentType(
    response: SafeResponse,
    options: SafeRequestOptions,
  ): void {
    const expected = options.expectedContentTypes;
    if (!expected || expected.length === 0) return;
    if (response.status >= 400) return;
    const actual = response.contentType ?? "";
    if (!expected.some((type) => actual.startsWith(type))) {
      response.discard();
      throw new GatewayError(
        "DISCOVERY_FAILED",
        `Unexpected content type "${clampText(actual, 80)}"`,
        { data: { expected: expected.join(", ") } },
      );
    }
  }

  private requestOnce(
    rawUrl: string,
    options: SafeRequestOptions,
    requestHeaders: Record<string, string | undefined> | undefined,
  ): Promise<SafeResponse> {
    const url = parseAbsoluteUrl(rawUrl);
    if (url.protocol === "http:" && !this.policy.allowHttp) {
      this.blocked("http_scheme");
      throw new GatewayError("SSRF_BLOCKED", "Plain HTTP requests are disabled");
    }
    const host = url.hostname.toLowerCase();
    if (
      this.policy.hostAllowlist.length > 0 &&
      !this.policy.hostAllowlist.includes(host)
    ) {
      this.blocked("host_not_allowlisted");
      throw new GatewayError("SSRF_BLOCKED", `Host is not allowlisted: ${host}`);
    }

    // Node connects directly when the host is an IP literal and never calls
    // the lookup hook, so the literal has to be judged here instead.
    const literal = literalAddressOf(host);
    if (literal !== null && !this.addressPermitted(literal, host)) {
      this.blocked("blocked_address");
      throw new GatewayError(
        "SSRF_BLOCKED",
        `Refusing to connect to ${host}: the address is not publicly routable`,
      );
    }

    const maxBytes = options.maxResponseBytes ?? this.policy.maxResponseBytes;
    const timeoutMs = options.timeoutMs ?? this.policy.timeoutMs;
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(requestHeaders ?? {})) {
      if (value !== undefined) headers[key] = value;
    }
    if (options.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }

    return new Promise<SafeResponse>((resolve, reject) => {
      const req = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === "" ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: options.method ?? "GET",
          headers,
          lookup: this.guardedLookup(host),
          servername: url.hostname,
        },
        (res) => {
          resolve(this.wrapResponse(url.href, res, maxBytes));
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request to ${url.host} timed out`));
      });
      req.on("error", (error) => {
        if (error instanceof SsrfBlocked) {
          reject(new GatewayError("SSRF_BLOCKED", error.message));
          return;
        }
        reject(
          new GatewayError("UPSTREAM_UNAVAILABLE", clampText(error.message, 200), {
            cause: error,
            retryable: true,
          }),
        );
      });
      if (options.signal) {
        if (options.signal.aborted) req.destroy(new Error("Request aborted"));
        else
          options.signal.addEventListener(
            "abort",
            () => req.destroy(new Error("Request aborted")),
            { once: true },
          );
      }
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  /**
   * An operator allowlist entry opts a host out of the routability rules, but
   * never out of the cloud metadata block: that address is never a legitimate
   * MCP endpoint and reaching it discloses the deployment's own credentials.
   */
  private addressPermitted(address: string, host: string): boolean {
    const disposition = classifyAddress(address);
    if (this.policy.allowedHosts.includes(host)) {
      return disposition !== "CLOUD_METADATA";
    }
    return dispositionAllowed(disposition, this.policy);
  }

  private guardedLookup(host: string): LookupFunction {
    const metrics = this.metrics;
    return ((hostname, lookupOptions, callback) => {
      dnsLookup(hostname, { ...(lookupOptions as object), all: true }, (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        const resolved = addresses as { address: string; family: number }[];
        const permitted = resolved.filter((entry) =>
          this.addressPermitted(entry.address, host),
        );
        if (permitted.length === 0) {
          metrics?.counter(Metric.SsrfRequestBlocked, { reason: "blocked_address" });
          callback(
            new SsrfBlocked(
              `Refusing to connect to ${hostname}: resolved address is not publicly routable`,
            ),
            "",
            0,
          );
          return;
        }
        if ((lookupOptions as { all?: boolean }).all === true) {
          (callback as unknown as (err: null, addresses: unknown) => void)(
            null,
            permitted,
          );
          return;
        }
        const first = permitted[0];
        if (!first) {
          callback(new SsrfBlocked("No permitted address"), "", 0);
          return;
        }
        callback(null, first.address, first.family);
      });
    }) as LookupFunction;
  }

  private blocked(reason: string): void {
    this.metrics?.counter(Metric.SsrfRequestBlocked, { reason });
  }

  private wrapResponse(
    url: string,
    res: IncomingMessage,
    maxBytes: number,
  ): SafeResponse {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(", ");
    }
    const rawType = headers["content-type"] ?? null;
    const contentType = rawType === null ? null : (rawType.split(";")[0] ?? "").trim();

    const readText = async (): Promise<string> => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += buffer.length;
        if (total > maxBytes) {
          res.destroy();
          throw new GatewayError(
            "PAYLOAD_TOO_LARGE",
            `Response from ${new URL(url).host} exceeded ${maxBytes} bytes`,
          );
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    };

    return {
      url,
      status: res.statusCode ?? 0,
      headers,
      contentType,
      body: res,
      text: readText,
      json: async () => {
        const text = await readText();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new GatewayError(
            "DISCOVERY_FAILED",
            `Malformed JSON received from ${new URL(url).host}`,
          );
        }
      },
      discard: () => {
        res.resume();
        res.destroy();
      },
    };
  }
}
