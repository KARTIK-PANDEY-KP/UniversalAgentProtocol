import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";

import { GatewayError, clampText } from "@umg/core";
import { Metric, type MetricsRegistry } from "@umg/observability";

import { classifyAddress, type IpDisposition } from "./ip-rules.js";
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
    const maxRedirects = options.followRedirects === false ? 0 : this.policy.maxRedirects;
    let current = typeof options.url === "string" ? options.url : options.url.href;
    let hop = 0;

    for (;;) {
      const response = await this.requestOnce(current, options);
      const location = response.headers["location"];
      const isRedirect =
        response.status >= 300 && response.status < 400 && location !== undefined;
      const method = (options.method ?? "GET").toUpperCase();
      const redirectable = method === "GET" || method === "HEAD";
      if (!isRedirect || !redirectable || hop >= maxRedirects) {
        if (isRedirect && redirectable && hop >= maxRedirects) {
          response.discard();
          throw new GatewayError(
            "DISCOVERY_FAILED",
            "Too many redirects while fetching metadata",
          );
        }
        this.assertContentType(response, options);
        return response;
      }
      response.discard();
      current = new URL(location, current).href;
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

    const maxBytes = options.maxResponseBytes ?? this.policy.maxResponseBytes;
    const timeoutMs = options.timeoutMs ?? this.policy.timeoutMs;
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
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

  private guardedLookup(host: string): LookupFunction {
    const policy = this.policy;
    const metrics = this.metrics;
    const explicitlyAllowed = policy.allowedHosts.includes(host);
    return ((hostname, lookupOptions, callback) => {
      dnsLookup(hostname, { ...(lookupOptions as object), all: true }, (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        const resolved = addresses as { address: string; family: number }[];
        const permitted = resolved.filter((entry) => {
          const disposition = classifyAddress(entry.address);
          if (explicitlyAllowed && disposition !== "CLOUD_METADATA") return true;
          return dispositionAllowed(disposition, policy);
        });
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
