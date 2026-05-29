import { describe, it, expect, vi } from "vitest";
import { createCircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createCircuitBreaker", () => {
  it("closed → open at the failure threshold", async () => {
    const clock = fakeClock();
    const onOpen = vi.fn();
    const cb = createCircuitBreaker({
      name: "svc",
      failureThreshold: 3,
      windowMs: 60_000,
      halfOpenAfterMs: 30_000,
      now: clock.now,
      onOpen,
    });

    const bad = async () => {
      throw new Error("boom");
    };

    await expect(cb.exec(bad)).rejects.toThrow("boom");
    expect(cb.state()).toBe("closed");
    await expect(cb.exec(bad)).rejects.toThrow("boom");
    expect(cb.state()).toBe("closed");
    await expect(cb.exec(bad)).rejects.toThrow("boom");
    expect(cb.state()).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("svc");
  });

  it("open breaker throws CircuitOpenError without invoking fn", async () => {
    const clock = fakeClock();
    const cb = createCircuitBreaker({
      name: "svc",
      failureThreshold: 1,
      windowMs: 60_000,
      halfOpenAfterMs: 30_000,
      now: clock.now,
    });

    const probe = vi.fn<() => Promise<string>>(async () => {
      throw new Error("down");
    });

    await expect(cb.exec(probe)).rejects.toThrow("down");
    expect(cb.state()).toBe("open");
    expect(probe).toHaveBeenCalledTimes(1);

    await expect(cb.exec(probe)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(cb.exec(probe)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(probe).toHaveBeenCalledTimes(1); // still 1 — fn never invoked while open
  });

  it("open → half_open after cooldown, success closes the circuit", async () => {
    const clock = fakeClock();
    const onOpen = vi.fn();
    const cb = createCircuitBreaker({
      name: "svc",
      failureThreshold: 1,
      windowMs: 60_000,
      halfOpenAfterMs: 30_000,
      now: clock.now,
      onOpen,
    });

    await expect(
      cb.exec(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(cb.state()).toBe("open");

    // still within cooldown
    clock.advance(20_000);
    await expect(cb.exec(async () => "ok")).rejects.toBeInstanceOf(CircuitOpenError);

    // past cooldown → next exec is the probe
    clock.advance(20_000);
    const probe = vi.fn<() => Promise<string>>(async () => "ok");
    const result = await cb.exec(probe);
    expect(result).toBe("ok");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cb.state()).toBe("closed");
    // onOpen was called once for the initial trip — the probe recovery does NOT re-emit.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("half_open failure sends the breaker back to open with a fresh openedAt", async () => {
    const clock = fakeClock();
    const onOpen = vi.fn();
    const cb = createCircuitBreaker({
      name: "svc",
      failureThreshold: 1,
      windowMs: 60_000,
      halfOpenAfterMs: 30_000,
      now: clock.now,
      onOpen,
    });

    await expect(
      cb.exec(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(cb.state()).toBe("open");

    clock.advance(30_000);
    // half_open probe fails
    await expect(
      cb.exec(async () => {
        throw new Error("still-down");
      }),
    ).rejects.toThrow("still-down");
    expect(cb.state()).toBe("open");

    // cooldown resets — shortly after probe failure the breaker is still open
    clock.advance(20_000);
    await expect(cb.exec(async () => "ok")).rejects.toBeInstanceOf(CircuitOpenError);

    // and another onOpen event fires for the new trip
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("rolling window drops failures that age past windowMs", async () => {
    const clock = fakeClock();
    const cb = createCircuitBreaker({
      name: "svc",
      failureThreshold: 3,
      windowMs: 60_000,
      halfOpenAfterMs: 30_000,
      now: clock.now,
    });

    const bad = async () => {
      throw new Error("boom");
    };

    await expect(cb.exec(bad)).rejects.toThrow();
    await expect(cb.exec(bad)).rejects.toThrow();
    expect(cb.state()).toBe("closed");

    // advance past the window — the two failures should be forgotten.
    clock.advance(61_000);

    await expect(cb.exec(bad)).rejects.toThrow();
    await expect(cb.exec(bad)).rejects.toThrow();
    expect(cb.state()).toBe("closed"); // only 2 in the current window

    await expect(cb.exec(bad)).rejects.toThrow();
    expect(cb.state()).toBe("open"); // 3 recent failures → trip
  });

  it("onOpen fires exactly once per closed→open transition", async () => {
    const clock = fakeClock();
    const onOpen = vi.fn();
    const cb = createCircuitBreaker({
      name: "svc",
      failureThreshold: 1,
      windowMs: 60_000,
      halfOpenAfterMs: 30_000,
      now: clock.now,
      onOpen,
    });

    await expect(
      cb.exec(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow();
    // repeated open-state rejections do NOT re-emit
    await expect(cb.exec(async () => "ok")).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(cb.exec(async () => "ok")).rejects.toBeInstanceOf(CircuitOpenError);

    expect(onOpen).toHaveBeenCalledTimes(1);

    // recover
    clock.advance(30_000);
    await cb.exec(async () => "ok");
    expect(cb.state()).toBe("closed");
    expect(onOpen).toHaveBeenCalledTimes(1);

    // trip again — another onOpen event
    await expect(
      cb.exec(async () => {
        throw new Error("down-again");
      }),
    ).rejects.toThrow();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
