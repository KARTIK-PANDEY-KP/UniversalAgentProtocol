import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteMatch {
  params: Record<string, string>;
  query: URLSearchParams;
  url: URL;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RouteMatch,
) => Promise<void> | void;

interface Route {
  method: string | "ALL";
  segments: string[];
  handler: RouteHandler;
}

/**
 * A dependency-free router. The gateway only needs exact segments and `:name`
 * parameters, so a full framework would add supply chain surface for nothing.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string | "ALL", pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method,
      segments: pattern.split("/").filter((segment) => segment.length > 0),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add("DELETE", pattern, handler);
  }

  all(pattern: string, handler: RouteHandler): this {
    return this.add("ALL", pattern, handler);
  }

  resolve(
    method: string,
    url: URL,
  ): { handler: RouteHandler; match: RouteMatch } | null {
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    for (const route of this.routes) {
      if (route.method !== "ALL" && route.method !== method) continue;
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index] ?? "";
        const actual = segments[index] ?? "";
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(actual);
          continue;
        }
        if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      return {
        handler: route.handler,
        match: { params, query: url.searchParams, url },
      };
    }
    return null;
  }
}
