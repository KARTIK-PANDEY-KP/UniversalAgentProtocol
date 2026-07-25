import { GatewayError } from "@umg/core";

export interface RateLimitRule {
  /** Sustained requests allowed per interval. */
  limit: number;
  intervalMs: number;
  /** Burst allowance; defaults to the sustained limit. */
  burst?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds the caller should wait, for a `Retry-After` header. */
  retryAfterSeconds: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A token bucket per key. Buckets refill continuously rather than resetting on
 * a boundary, so a caller that spreads its work out is never punished for the
 * moment a fixed window happens to roll over.
 *
 * State is per process. Running several gateway replicas divides the effective
 * limit between them, which is the safe direction to be wrong in; a deployment
 * that needs an exact global limit puts one in front of the fleet.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return this.rule.limit > 0;
  }

  private get capacity(): number {
    return this.rule.burst ?? this.rule.limit;
  }

  check(key: string): RateLimitDecision {
    if (!this.enabled) {
      return { allowed: true, retryAfterSeconds: 0, remaining: Number.POSITIVE_INFINITY };
    }
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const refill = ((now - bucket.updatedAt) / this.rule.intervalMs) * this.rule.limit;
    const tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, refill));

    if (tokens < 1) {
      // Report the wait for one whole token, rounded up so a caller that obeys
      // it succeeds rather than arriving a millisecond early.
      const waitMs = ((1 - tokens) / this.rule.limit) * this.rule.intervalMs;
      this.buckets.set(key, { tokens, updatedAt: now });
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        remaining: 0,
      };
    }

    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.floor(tokens - 1),
    };
  }

  /** Throws `RATE_LIMITED` when the caller is over its budget. */
  require(key: string, what: string): void {
    const decision = this.check(key);
    if (decision.allowed) return;
    throw new GatewayError("RATE_LIMITED", `Too many ${what}; retry shortly`, {
      data: { retry_after_seconds: decision.retryAfterSeconds },
      retryable: true,
    });
  }

  /** Discards buckets that have refilled, so idle keys do not accumulate. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of [...this.buckets]) {
      const refill = ((now - bucket.updatedAt) / this.rule.intervalMs) * this.rule.limit;
      if (bucket.tokens + refill < this.capacity) continue;
      this.buckets.delete(key);
      removed += 1;
    }
    return removed;
  }
}
