/**
 * Shared Redis client singleton.
 *
 * The rate limiter consumes this via the port injected at factory time.
 * Kept in its own module so tests can `vi.mock("ioredis")` once and have
 * both consumers see the same mock instance, and so the connection config
 * (TLS, timeouts, retries) lives in exactly one place.
 */
import { Redis } from "ioredis";
import { config } from "./config/index.js";
import { logger } from "./logger.js";

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    const isTls = config.REDIS_URL.startsWith("rediss://");
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
