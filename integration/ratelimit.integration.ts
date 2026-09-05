/**
 * The rate limiter's Lua script, run by a Redis.
 *
 * The unit suite proves the limiter asks Redis for one indivisible operation
 * rather than a read and then a write, and it proves that against a fake whose
 * `eval` is a transcription of the script. A transcription is not the script:
 * it cannot fail on Lua that does not parse, on a `redis.call` with the wrong
 * arity, on an argument Redis hands over as a string where the script expects a
 * number, or on a reply shape the client cannot read. Those are the failures
 * that only a server produces, and they are why this tier exists.
 *
 * It also re-asserts the concurrency property here, against real clients and a
 * real server, because the unit-level version is only as good as the fake's
 * model of Redis. Neither tier subsumes the other: the fake can run anywhere and
 * cannot run Lua, the server runs Lua and needs to exist.
 *
 * REDIS_URL selects the server; the CI job supplies a service container.
 */
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/ratelimit/redis-limiter.js";

const URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let clients: Redis[] = [];
const connect = () => {
  const c = new Redis(URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  clients.push(c);
  return c;
};

let redis: Redis;

beforeAll(async () => {
  redis = connect();
  // Fail here rather than in the first assertion: a suite that cannot reach
  // Redis has verified nothing, and that is a different report from a failure.
  await redis.ping();
});

afterEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit()));
  clients = [];
});

const limiterOn = (client: Redis, userPerHour: number, workspacePerHour: number, now = NOW) =>
  createRateLimiter({ redis: client, userPerHour, workspacePerHour, now: () => now });

describe("the limiter's script, executed by Redis", () => {
  it("admits up to the user limit and refuses after it", async () => {
    const limiter = limiterOn(redis, 3, 1000);

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.check("U1", "W1"));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[0].remaining).toBe(2);
    expect(results[2].remaining).toBe(0);
    expect(results[3].limitType).toBe("user");
    expect(await redis.zcard("ratelimit:user:U1")).toBe(3);
  });

  it("refuses on the workspace limit without charging the user a slot", async () => {
    const limiter = limiterOn(redis, 100, 2);

    await limiter.check("U1", "W1");
    await limiter.check("U2", "W1");
    const refused = await limiter.check("U3", "W1");

    expect(refused.allowed).toBe(false);
    expect(refused.limitType).toBe("workspace");
    // The whole reason both keys are decided in one script: a request the
    // workspace limit refuses must not have spent a user slot on the way.
    expect(await redis.zcard("ratelimit:user:U3")).toBe(0);
    expect(await redis.zcard("ratelimit:workspace:W1")).toBe(2);
  });

  it("admits exactly the limit when the requests arrive together on many connections", async () => {
    const LIMIT = 5;
    const CONNECTIONS = 10;
    const PER_CONNECTION = 5;

    // Separate connections, so the result cannot be an artefact of one client
    // serialising its own commands.
    const limiters = Array.from({ length: CONNECTIONS }, () => limiterOn(connect(), LIMIT, 10_000));
    await Promise.all(limiters.map((_, i) => clients[i + 1].ping()));

    const results = await Promise.all(
      limiters.flatMap((limiter) =>
        Array.from({ length: PER_CONNECTION }, () => limiter.check("U1", "W1")),
      ),
    );

    expect(results).toHaveLength(CONNECTIONS * PER_CONNECTION);
    expect(results.filter((r) => r.allowed).length).toBe(LIMIT);
    expect(await redis.zcard("ratelimit:user:U1")).toBe(LIMIT);
  });

  it("lets the window slide: entries older than an hour stop counting", async () => {
    const first = limiterOn(redis, 2, 1000, NOW);
    await first.check("U1", "W1");
    await first.check("U1", "W1");
    expect((await first.check("U1", "W1")).allowed).toBe(false);

    const later = limiterOn(redis, 2, 1000, NOW + HOUR + 1);
    const afterWindow = await later.check("U1", "W1");

    expect(afterWindow.allowed).toBe(true);
    // The pruned entries are gone from the set, not merely ignored.
    expect(await redis.zcard("ratelimit:user:U1")).toBe(1);
  });

  it("sets an expiry, so a key does not outlive the window it counts", async () => {
    const limiter = limiterOn(redis, 10, 1000);
    await limiter.check("U1", "W1");

    for (const key of ["ratelimit:user:U1", "ratelimit:workspace:W1"]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(HOUR / 1000);
      expect(ttl).toBeLessThanOrEqual(HOUR / 1000 + 10);
    }
  });

  it("returns a reply the limiter reads without guessing", async () => {
    // Redis hands Lua every argument as a string and returns a table as a
    // flat array of integers. The limiter destructures that array positionally,
    // so its shape is part of the contract rather than an implementation detail.
    const limiter = limiterOn(redis, 1, 1000);
    const admitted = await limiter.check("U1", "W1");
    const refused = await limiter.check("U1", "W1");

    expect(admitted).toEqual({ allowed: true, remaining: 0, resetAt: NOW + HOUR });
    expect(refused).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: NOW + HOUR,
      limitType: "user",
    });
  });
});
