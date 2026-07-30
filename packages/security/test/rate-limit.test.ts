import { describe, expect, it } from "vitest";

import { GatewayError } from "@uap/core";

import { RateLimiter } from "@uap/security";

describe("RateLimiter", () => {
  function limiter(limit: number, burst?: number) {
    let now = 0;
    const rule = burst === undefined ? { limit, intervalMs: 1000 } : { limit, intervalMs: 1000, burst };
    return {
      limiter: new RateLimiter(rule, () => now),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("allows a full bucket then refuses", () => {
    const { limiter: bucket } = limiter(3);

    expect([0, 1, 2].map(() => bucket.check("t").allowed)).toEqual([true, true, true]);
    expect(bucket.check("t").allowed).toBe(false);
  });

  it("refills continuously rather than at a window boundary", () => {
    const { limiter: bucket, advance } = limiter(2);
    bucket.check("t");
    bucket.check("t");
    expect(bucket.check("t").allowed).toBe(false);

    // Half an interval buys one of the two tokens back.
    advance(500);
    expect(bucket.check("t").allowed).toBe(true);
    expect(bucket.check("t").allowed).toBe(false);
  });

  it("never refills past the burst allowance", () => {
    const { limiter: bucket, advance } = limiter(2, 4);
    advance(60_000);

    expect([0, 1, 2, 3].map(() => bucket.check("t").allowed)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(bucket.check("t").allowed).toBe(false);
  });

  it("keeps one key's budget away from another's", () => {
    const { limiter: bucket } = limiter(1);
    expect(bucket.check("a").allowed).toBe(true);
    expect(bucket.check("a").allowed).toBe(false);
    expect(bucket.check("b").allowed).toBe(true);
  });

  it("reports a wait long enough to succeed on", () => {
    const { limiter: bucket, advance } = limiter(1);
    bucket.check("t");
    const refused = bucket.check("t");

    expect(refused.allowed).toBe(false);
    advance(refused.retryAfterSeconds * 1000);
    expect(bucket.check("t").allowed).toBe(true);
  });

  it("is disabled by a limit of zero", () => {
    const { limiter: bucket } = limiter(0);
    expect(bucket.enabled).toBe(false);
    expect([0, 1, 2, 3].every(() => bucket.check("t").allowed)).toBe(true);
  });

  it("raises a retryable RATE_LIMITED error when required", () => {
    const { limiter: bucket } = limiter(1);
    bucket.require("t", "tool calls");

    try {
      bucket.require("t", "tool calls");
      expect.unreachable("the second call should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("RATE_LIMITED");
      expect((error as GatewayError).httpStatus).toBe(429);
      expect((error as GatewayError).retryable).toBe(true);
    }
  });

  it("forgets a key once its bucket has refilled", () => {
    const { limiter: bucket, advance } = limiter(1);
    bucket.check("t");
    expect(bucket.sweep()).toBe(0);

    advance(1000);
    expect(bucket.sweep()).toBe(1);
  });
});
