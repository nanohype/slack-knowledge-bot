/**
 * Shared Redis client singleton.
 *
 * The rate limiter consumes this via the `RateLimiterRedisPort` injected at
 * factory time — tests pass a port fake, never `vi.mock("ioredis")` (the
 * SDK-mock ban is grep-enforced in CI). Kept in its own module so the
 * connection config (TLS, timeouts, retries) lives in exactly one place and
 * every consumer shares the one client singleton.
 */
import { Redis } from 'ioredis';
import { config } from './config/index.js';
import { logger } from './logger.js';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    const isTls = config.REDIS_URL.startsWith('rediss://');
    redisClient = new Redis(config.REDIS_URL, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
      ...(isTls ? { tls: { rejectUnauthorized: true } } : {}),
    });
    redisClient.on('error', (err: Error) => logger.error({ err }, 'Redis connection error'));
  }
  return redisClient;
}
