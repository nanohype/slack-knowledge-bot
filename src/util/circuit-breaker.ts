/**
 * Circuit breaker for external-IO calls.
 *
 * Failure accounting is sliding-window: every failure is stamped with
 * `now()` and dropped from the log as soon as it falls outside `windowMs`.
 * When the count within the window reaches `failureThreshold` the breaker
 * opens; all subsequent calls fail fast with `CircuitOpenError` until a
 * cooldown of `halfOpenAfterMs` elapses.
 *
 * Half-open allows exactly ONE probe at a time — if it succeeds the
 * breaker closes and the window resets; if it fails (or another call
 * comes in while the probe is in flight) the breaker goes straight back
 * to open with a fresh `openedAt`.
 *
 * `onOpen` is fired once per closed→open transition (not on every
 * rejection after the breaker is already open) so a counter wired here
 * matches the number of trips, not the blast radius.
 *
 * Not dependent on real timers — all time reads go through the injected
 * `now()` so tests can tick a fake clock synchronously.
 */

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`circuit open: ${name}`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreaker {
  exec<T>(fn: () => Promise<T>): Promise<T>;
  state(): CircuitState;
}

export interface CircuitBreakerConfig {
  name: string;
  /** failures within `windowMs` to trip the breaker (closed → open). */
  failureThreshold: number;
  /** rolling-window size for failure accounting. */
  windowMs: number;
  /** cooldown after opening before a single half-open probe is allowed. */
  halfOpenAfterMs: number;
  now?: () => number;
  /** Emitted once per closed→open transition. */
  onOpen?: (name: string) => void;
}

export function createCircuitBreaker(cfg: CircuitBreakerConfig): CircuitBreaker {
  const now = cfg.now ?? (() => Date.now());

  let state: CircuitState = "closed";
  let failures: number[] = [];
  let openedAt = 0;
  let halfOpenInFlight = false;

  function pruneFailures(t: number): void {
    const cutoff = t - cfg.windowMs;
    if (failures.length === 0) return;
    if (failures[0] >= cutoff) return;
    failures = failures.filter((ts) => ts >= cutoff);
  }

  function tripOpen(t: number): void {
    state = "open";
    openedAt = t;
    failures = [];
    cfg.onOpen?.(cfg.name);
  }

  function maybeEnterHalfOpen(t: number): void {
    if (state !== "open") return;
    if (t - openedAt >= cfg.halfOpenAfterMs) {
      state = "half_open";
      halfOpenInFlight = false;
    }
  }

  return {
    state: () => state,
    async exec<T>(fn: () => Promise<T>): Promise<T> {
      const t = now();

      if (state === "open") {
        maybeEnterHalfOpen(t);
        if (state === "open") {
          throw new CircuitOpenError(cfg.name);
        }
      }

      if (state === "half_open") {
        if (halfOpenInFlight) {
          // Only one probe at a time — reject fast so we don't pile on the
          // downstream while waiting for the canary to resolve.
          throw new CircuitOpenError(cfg.name);
        }
        halfOpenInFlight = true;
        try {
          const result = await fn();
          state = "closed";
          failures = [];
          halfOpenInFlight = false;
          return result;
        } catch (err) {
          halfOpenInFlight = false;
          tripOpen(now());
          throw err;
        }
      }

      // closed
      try {
        return await fn();
      } catch (err) {
        const failedAt = now();
        pruneFailures(failedAt);
        failures.push(failedAt);
        if (failures.length >= cfg.failureThreshold) {
          tripOpen(failedAt);
        }
        throw err;
      }
    },
  };
}
