import { describe, it, expect, vi } from "vitest";
import {
  createRateLimiter,
  type RateLimiterRedisPort,
  type RedisPipelinePort,
} from "./redis-limiter.js";

/**
 * Build a fake ioredis pipeline. Each `exec` call returns the next entry
 * from `execResults`. Chainable zremrangebyscore/zcard/zadd/expire return
 * `this` for chaining.
 */
function buildRedis(execResults: Array<Array<[Error | null, unknown]> | null | Error>) {
  const queue = [...execResults];
  const pipeline: RedisPipelinePort = {
    zremrangebyscore: vi.fn(() => pipeline),
    zcard: vi.fn(() => pipeline),
    zadd: vi.fn(() => pipeline),
    expire: vi.fn(() => pipeline),
    exec: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("exec called more times than configured");
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const redis: RateLimiterRedisPort = {
    pipeline: vi.fn(() => pipeline),
  };
  return { redis, pipeline };
}

const NOW = 1_700_000_000_000;

describe("createRateLimiter", () => {
  it("allows when user and workspace are under limit and writes the request", async () => {
    const { redis, pipeline } = buildRedis([
      [
        [null, 0],
        [null, 0],
        [null, 3],
        [null, 10],
      ],
      [
        [null, 1],
        [null, 1],
        [null, 1],
        [null, 1],
      ],
    ]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });
    const result = await limiter.check("U123", "W456");
    expect(result).toEqual({
      allowed: true,
      remaining: 16,
      resetAt: NOW + 60 * 60 * 1000,
    });
    expect(pipeline.zadd).toHaveBeenCalledWith(
      "ratelimit:user:U123",
      NOW,
      expect.stringMatching(/^1700000000000-/),
    );
    expect(pipeline.zadd).toHaveBeenCalledWith(
      "ratelimit:workspace:W456",
      NOW,
      expect.stringMatching(/^1700000000000-/),
    );
  });

  it("blocks when the per-user count is at the limit", async () => {
    const { redis, pipeline } = buildRedis([
      [
        [null, 0],
        [null, 0],
        [null, 20],
        [null, 100],
      ],
    ]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });
    const result = await limiter.check("U123", "W456");
    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: NOW + 60 * 60 * 1000,
      limitType: "user",
    });
    // Must NOT write a new entry when blocked.
    expect(pipeline.zadd).not.toHaveBeenCalled();
  });

  it("blocks when the per-workspace count is at the limit even if the user is under", async () => {
    const { redis } = buildRedis([
      [
        [null, 0],
        [null, 0],
        [null, 2],
        [null, 500],
      ],
    ]);
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

  it("fails open when exec throws (Redis unreachable)", async () => {
    const { redis, pipeline } = buildRedis([new Error("ETIMEDOUT")]);
    const limiter = createRateLimiter({
      redis,
      userPerHour: 20,
      workspacePerHour: 500,
      now: () => NOW,
    });
    const result = await limiter.check("U123", "W456");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(-1);
    // Fail-open must not attempt a write.
    expect(pipeline.zadd).not.toHaveBeenCalled();
  });

  it("fails open when exec returns null (pipeline aborted)", async () => {
    const { redis } = buildRedis([null]);
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
});
