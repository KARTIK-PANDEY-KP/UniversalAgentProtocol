/**
 * Time, injected rather than read from the ambient clock. Every component
 * takes a `Clock`, which is what lets a test move time without sleeping.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Exponential backoff with full jitter on the lower half of the interval, so
 * a fleet of gateways that all failed against the same authorization server
 * does not retry against it in lockstep.
 */
export function jitteredBackoff(
  attempt: number,
  baseMs = 250,
  maxMs = 30_000,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}
