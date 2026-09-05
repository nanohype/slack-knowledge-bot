import { describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  RATE_LIMIT_SCRIPT,
  type RateLimiterRedisPort,
} from "./redis-limiter.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** A reply the script would send: [allowed, remaining, limitType]. */
const reply = (allowed: number, remaining: number, limitType = 0) => [
  allowed,
  remaining,
  limitType,
];

function buildRedis(replies: Array<unknown | Error>) {
  const queue = [...replies];
  const redis: RateLimiterRedisPort = {
    eval: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("eval called more times than configured");
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return { redis, evalFn: redis.eval as ReturnType<typeof vi.fn> };
}

describe("createRateLimiter", () => {
  it("allows when the script admits, and spends the request in the same call", async () => {
    const { redis, evalFn } = buildRedis([reply(1, 16)]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });

    const result = await limiter.check("U123", "W456");

    expect(result).toEqual({ allowed: true, remaining: 16, resetAt: NOW + HOUR });
    // One call, not a read and then a write: the decision and the spend are the
    // same operation, which is the whole property.
    expect(evalFn).toHaveBeenCalledTimes(1);
    expect(evalFn).toHaveBeenCalledWith(
      RATE_LIMIT_SCRIPT,
      2,
      "ratelimit:user:U123",
      "ratelimit:workspace:W456",
      NOW,
      NOW - HOUR,
      20,
      500,
      expect.stringMatching(/^1700000000000-/),
      3610,
    );
  });

  it("blocks when the script refuses on the user limit", async () => {
    const { redis } = buildRedis([reply(0, 0, 1)]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });

    expect(await limiter.check("U123", "W456")).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: NOW + HOUR,
      limitType: "user",
    });
  });

  it("blocks when the script refuses on the workspace limit", async () => {
    const { redis } = buildRedis([reply(0, 0, 2)]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });

    const result = await limiter.check("U123", "W456");
    expect(result.allowed).toBe(false);
    expect(result.limitType).toBe("workspace");
    expect(result.remaining).toBe(0);
  });

  it("fails open when the script throws (Redis unreachable)", async () => {
    const { redis } = buildRedis([new Error("ETIMEDOUT")]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });

    const result = await limiter.check("U123", "W456");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(-1);
  });

  it("fails open on a reply it cannot read rather than guessing at it", async () => {
    for (const unreadable of [null, "OK", [1]]) {
      const { redis } = buildRedis([unreadable]);
      const limiter = createRateLimiter({
        redis,
        userPerHour: 20,
        workspacePerHour: 500,
        now: () => NOW,
      });
      const result = await limiter.check("U123", "W456");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(-1);
    }
  });
});

/* ────────────────────────── the concurrency gate ───────────────────────── */

/**
 * A Redis with the execution contract that matters here.
 *
 * Every call awaits a turn of the event loop before touching the store, which is
 * what a network round trip does to a caller: it is the yield that lets another
 * request run in between. After that yield the store is mutated with no further
 * await, which is what Redis's single thread does — one command, or one script,
 * runs to completion before any other client is served.
 *
 * So the difference between a limiter that spends what it counted and one that
 * counts and then spends is visible here as the difference between one yield and
 * two, which is exactly the difference the fix makes.
 */
function createConcurrentRedis() {
  const sets = new Map<string, Map<string, number>>();
  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
  const members = (key: string) => {
    let s = sets.get(key);
    if (!s) {
      s = new Map();
      sets.set(key, s);
    }
    return s;
  };
  const prune = (key: string, windowStart: number) => {
    for (const [m, score] of members(key)) if (score <= windowStart) members(key).delete(m);
  };

  return {
    sets,

    /** What Redis does with the script: the whole of it, uninterrupted. */
    async eval(_script: string, _numKeys: number, ...args: Array<string | number>) {
      await turn();
      const [userKey, workspaceKey, at, windowStart, userLimit, workspaceLimit, member] = args as [
        string,
        string,
        number,
        number,
        number,
        number,
        string,
      ];
      prune(userKey, windowStart);
      prune(workspaceKey, windowStart);
      const userCount = members(userKey).size;
      const workspaceCount = members(workspaceKey).size;
      if (userCount >= userLimit) return [0, 0, 1];
      if (workspaceCount >= workspaceLimit) return [0, workspaceLimit - workspaceCount, 2];
      members(userKey).set(member, at);
      members(workspaceKey).set(member, at);
      return [1, userLimit - userCount - 1, 0];
    },

    /**
     * The check-then-act shape, kept only as a control.
     *
     * A concurrency test that cannot observe the race would pass on a limiter
     * that still has it — a fake that serialised its callers, or a test that did
     * not really run them together, reports "the limit held" either way. This is
     * how the harness proves it can see the defect it claims the fix removes.
     */
    async checkNonAtomically(userKey: string, workspaceKey: string, at: number, limit: number) {
      await turn();
      const userCount = members(userKey).size;
      if (userCount >= limit) return false;
      await turn();
      members(userKey).set(`${at}-${Math.random()}`, at);
      members(workspaceKey).set(`${at}-${Math.random()}`, at);
      return true;
    },
  };
}

describe("the rate limiter under concurrent requests for one key", () => {
  const LIMIT = 5;
  const REQUESTS = 50;

  it("admits exactly the limit, however many requests arrive together", async () => {
    const redis = createConcurrentRedis();
    const limiter = createRateLimiter({
      redis,
      userPerHour: LIMIT,
      workspacePerHour: 10_000,
      now: () => NOW,
    });

    const results = await Promise.all(
      Array.from({ length: REQUESTS }, () => limiter.check("U123", "W456")),
    );

    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted).toBe(LIMIT);
    // And the count Redis holds agrees: nothing was admitted without being spent.
    expect(redis.sets.get("ratelimit:user:U123")?.size).toBe(LIMIT);
    expect(results.filter((r) => !r.allowed).every((r) => r.limitType === "user")).toBe(true);
  });

  it("the control over-admits, so the assertion above is not passing vacuously", async () => {
    const redis = createConcurrentRedis();

    const admitted = (
      await Promise.all(
        Array.from({ length: REQUESTS }, () =>
          redis.checkNonAtomically("ratelimit:user:U123", "ratelimit:workspace:W456", NOW, LIMIT),
        ),
      )
    ).filter(Boolean).length;

    // Every one of them reads the count before any of them writes, so the cap is
    // exceeded by the whole batch rather than by a little.
    expect(admitted).toBeGreaterThan(LIMIT);
    expect(admitted).toBe(REQUESTS);
  });

  it("keeps admitting up to the limit again once the window has passed", async () => {
    const redis = createConcurrentRedis();
    let clock = NOW;
    const limiter = createRateLimiter({
      redis,
      userPerHour: LIMIT,
      workspacePerHour: 10_000,
      now: () => clock,
    });

    const first = await Promise.all(
      Array.from({ length: REQUESTS }, () => limiter.check("U123", "W456")),
    );
    expect(first.filter((r) => r.allowed).length).toBe(LIMIT);

    clock = NOW + HOUR + 1;
    const second = await Promise.all(
      Array.from({ length: REQUESTS }, () => limiter.check("U123", "W456")),
    );
    expect(second.filter((r) => r.allowed).length).toBe(LIMIT);
  });

  it("charges no user slot to a request the workspace limit refuses", async () => {
    const redis = createConcurrentRedis();
    const limiter = createRateLimiter({
      redis,
      userPerHour: 100,
      workspacePerHour: 3,
      now: () => NOW,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiter.check(`U${i}`, "W456")),
    );

    expect(results.filter((r) => r.allowed).length).toBe(3);
    // Two scripts, one per key, would each be atomic and the pair would not:
    // a refused request would already have spent its user slot.
    for (let i = 0; i < 20; i++) {
      const spent = redis.sets.get(`ratelimit:user:U${i}`)?.size ?? 0;
      expect(spent).toBe(results[i].allowed ? 1 : 0);
    }
  });
});
