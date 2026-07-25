import { GatewayError } from "@umg/core";

export interface LockOptions {
  /** Maximum time to wait for the lock before failing. */
  waitMs?: number;
  /** Maximum time the critical section may hold the lock. */
  leaseMs?: number;
}

export interface DistributedLock {
  withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options?: LockOptions,
  ): Promise<T>;
}

/**
 * Serialises critical sections inside one process. Deployments that run more
 * than one gateway replica compose this with a storage backed lease so that
 * only one replica refreshes a given connection at a time.
 */
export class InProcessLock implements DistributedLock {
  private readonly queues = new Map<string, Promise<unknown>>();

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(
      key,
      previous.then(
        () => barrier,
        () => barrier,
      ),
    );
    await previous.catch(() => undefined);
    const timeout = options.leaseMs;
    try {
      if (timeout === undefined) return await fn();
      return await withDeadline(fn(), timeout, key);
    } finally {
      release();
      queueMicrotask(() => {
        if (this.queues.get(key) === barrier) this.queues.delete(key);
      });
    }
  }
}

async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  key: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new GatewayError("INTERNAL", `Lock lease expired for ${key}`, {
              retryable: true,
            }),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Trips after repeated upstream failures so the gateway stops hammering an
 * authorization server that is down, and stops burning refresh attempts.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}
