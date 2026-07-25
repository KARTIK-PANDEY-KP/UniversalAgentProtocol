import { describe, expect, it } from "vitest";

import { GatewayError } from "@umg/core";

import { InProcessLock } from "@umg/security";

/** A promise with its settle functions exposed, so a test can hold a lock open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InProcessLock", () => {
  it("runs one critical section at a time", async () => {
    const lock = new InProcessLock();
    const order: string[] = [];
    const first = deferred();

    const a = lock.withLock("k", async () => {
      order.push("a in");
      await first.promise;
      order.push("a out");
    });
    const b = lock.withLock("k", async () => {
      order.push("b in");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["a in"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a in", "a out", "b in"]);
  });

  it("lets a failed holder's successor through", async () => {
    const lock = new InProcessLock();
    const failure = lock.withLock("k", async () => {
      throw new Error("boom");
    });
    await expect(failure).rejects.toThrow("boom");
    await expect(lock.withLock("k", async () => "ok")).resolves.toBe("ok");
  });

  it("gives up waiting once waitMs is spent", async () => {
    const lock = new InProcessLock();
    const holder = deferred();
    const held = lock.withLock("k", async () => holder.promise);

    const waited = lock.withLock("k", async () => "never", { waitMs: 10 });
    await expect(waited).rejects.toThrow(/Timed out waiting for lock k/u);

    holder.resolve();
    await held;
  });

  it("does not lose the turn of a waiter that gave up", async () => {
    const lock = new InProcessLock();
    const holder = deferred();
    const held = lock.withLock("k", async () => holder.promise);

    await expect(
      lock.withLock("k", async () => "never", { waitMs: 10 }),
    ).rejects.toBeInstanceOf(GatewayError);

    const queued = lock.withLock("k", async () => "mine");
    holder.resolve();
    await held;
    await expect(queued).resolves.toBe("mine");
  });

  it("keeps the next holder out while an expired lease is still running", async () => {
    const lock = new InProcessLock();
    const runaway = deferred();
    let secondStarted = false;

    const expired = lock.withLock("k", async () => runaway.promise, { leaseMs: 10 });
    await expect(expired).rejects.toThrow(/Lock lease expired for k/u);

    const next = lock.withLock("k", async () => {
      secondStarted = true;
    });

    // The lease is gone but the work is not, and a second refresh starting here
    // is exactly what the lock exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondStarted).toBe(false);

    runaway.resolve();
    await next;
    expect(secondStarted).toBe(true);
  });

  it("tells the critical section that its lease expired", async () => {
    const lock = new InProcessLock();
    const aborted = deferred<boolean>();

    const expired = lock.withLock(
      "k",
      async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted.resolve(true);
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { leaseMs: 5 },
    );

    await expect(expired).rejects.toThrow(/lease expired/u);
    await expect(aborted.promise).resolves.toBe(true);
  });

  it("forgets a key once nothing is queued for it", async () => {
    const lock = new InProcessLock();
    await lock.withLock("k", async () => undefined);
    await lock.withLock("k", async () => undefined);

    // The queue map is private; its size is observable through the heap, so
    // assert on the property that matters: the entry does not accumulate.
    const tails = Reflect.get(lock, "tails") as Map<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tails.size).toBe(0);
  });

  it("keeps different keys independent", async () => {
    const lock = new InProcessLock();
    const holder = deferred();
    const held = lock.withLock("a", async () => holder.promise);

    await expect(lock.withLock("b", async () => "free")).resolves.toBe("free");

    holder.resolve();
    await held;
  });
});
