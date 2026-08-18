/**
 * Shared Redis client singleton.
 *
 * The rate limiter consumes this via the `RateLimiterRedisPort` injected at
 * factory time — tests pass a port fake, never `vi.mock("ioredis")` (the
 * SDK-mock ban is grep-enforced in CI). Kept in its own module so the
 * connection config (TLS, timeouts, retries) lives in exactly one place and
 * every consumer shares the one client singleton.
 */
import { Redis } from "ioredis";
import { config } from "./config/index.js";
import { logger } from "./logger.js";

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    const isTls = config.REDIS_URL.startsWith("rediss://");
    // ioredis 6 negotiates RESP3 by default. Left on the default deliberately:
    // the limiter's whole command set (ZREMRANGEBYSCORE / ZCARD / ZADD /
    // EXPIRE) replies with integers under both protocols, and pipeline().exec()
    // keeps its [err, result] tuple shape, so no reply parsing changes. The
    // commands whose replies RESP3 reshapes into maps — CONFIG GET, HGETALL,
    // XPENDING — are not ones this service issues. `protocol: 2` would pin the
    // v5 wire format if a cache ever needs it.
    redisClient = new Redis(config.REDIS_URL, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
      ...(isTls ? { tls: { rejectUnauthorized: true } } : {}),
    });
    redisClient.on("error", (err: Error) => logger.error({ err }, "Redis connection error"));
  }
  return redisClient;
}
