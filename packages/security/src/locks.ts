import { GatewayError } from "@umg/core";

export interface LockOptions {
  /** Maximum time to wait for the lock before failing. */
  waitMs?: number;
  /** Maximum time the critical section may hold the lock. */
  leaseMs?: number;
}

export interface LockContext {
  /**
   * Aborted when the lease expires. A critical section that can stop should
   * watch this: the caller has already been told the lease is gone, and
   * whatever the section does from here happens outside anyone's expectations.
   */
  readonly signal: AbortSignal;
}

export interface DistributedLock {
  withLock<T>(
    key: string,
    fn: (context: LockContext) => Promise<T>,
    options?: LockOptions,
  ): Promise<T>;
}

/**
 * Serialises critical sections inside one process. Deployments that run more
 * than one gateway replica compose this with a storage backed lease so that
 * only one replica refreshes a given connection at a time.
 */
export class InProcessLock implements DistributedLock {
  /**
   * The last promise queued for each key. A newcomer waits on it and replaces
   * it, so waiters form a chain rather than a list this class has to manage.
   */
  private readonly tails = new Map<string, Promise<unknown>>();

  async withLock<T>(
    key: string,
    fn: (context: LockContext) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => held,
      () => held,
    );
    this.tails.set(key, tail);

    const finish = (): void => {
      release();
      // Only if nobody queued behind us, or we would drop their turn.
      queueMicrotask(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    };

    try {
      await waitForTurn(previous, options.waitMs, key);
    } catch (error) {
      // We never entered, so let whoever is behind us through immediately.
      finish();
      throw error;
    }

    const controller = new AbortController();
    const work = fn({ signal: controller.signal });

    // The next holder waits for the work itself, not for this call to return.
    // A lease expiry gives up on the result; it does not make it safe for
    // someone else to start, which is the whole point of holding the lock.
    void work.then(finish, finish);

    if (options.leaseMs === undefined) return await work;

    let expiry: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          expiry = setTimeout(() => {
            controller.abort();
            reject(
              new GatewayError("INTERNAL", `Lock lease expired for ${key}`, {
                retryable: true,
              }),
            );
          }, options.leaseMs);
        }),
      ]);
    } finally {
      if (expiry) clearTimeout(expiry);
      // Swallow a rejection nobody is waiting for any more.
      void work.catch(() => undefined);
    }
  }
}

async function waitForTurn(
  previous: Promise<unknown>,
  waitMs: number | undefined,
  key: string,
): Promise<void> {
  // The holder's failure is the holder's problem; we only need our turn.
  const turn = previous.then(
    () => undefined,
    () => undefined,
  );
  if (waitMs === undefined) return turn;

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      turn,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new GatewayError("INTERNAL", `Timed out waiting for lock ${key}`, {
              retryable: true,
            }),
          );
        }, waitMs);
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
