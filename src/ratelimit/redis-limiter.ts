/**
 * Shared-state rate limiter using Redis.
 *
 * CRITICAL: Must use Redis, NOT in-memory Maps. With multiple pod
 * replicas, in-memory Maps would give each replica its own counter,
 * effectively multiplying the limit by replica count.
 *
 * Algorithm: sliding window with Redis sorted sets.
 *
 * Port-injected so tests can pass a fake Redis implementing only the
 * sorted-set methods the limiter actually uses — no vi.mock("ioredis").
 */
import { logger } from "../logger.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limitType?: "user" | "workspace";
}

/**
 * Narrow subset of ioredis surface the limiter actually uses.
 * Pipeline chaining returns `this`; exec returns an array of
 * [error, value] tuples.
 */
export interface RateLimiterRedisPort {
  pipeline(): RedisPipelinePort;
}

export interface RedisPipelinePort {
  zremrangebyscore(key: string, min: string | number, max: string | number): RedisPipelinePort;
  zcard(key: string): RedisPipelinePort;
  zadd(key: string, score: number, member: string): RedisPipelinePort;
  expire(key: string, seconds: number): RedisPipelinePort;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RateLimiterConfig {
  redis: RateLimiterRedisPort;
  userPerHour: number;
  workspacePerHour: number;
  now?: () => number;
}

export interface RateLimiter {
  check(slackUserId: string, workspaceId: string): Promise<RateLimitResult>;
}

export function createRateLimiter(deps: RateLimiterConfig): RateLimiter {
  const now = deps.now ?? (() => Date.now());
  const windowMs = 60 * 60 * 1000;

  return {
    async check(slackUserId, workspaceId) {
      const t = now();
      const windowStart = t - windowMs;
      const userKey = `ratelimit:user:${slackUserId}`;
      const workspaceKey = `ratelimit:workspace:${workspaceId}`;

      const p = deps.redis.pipeline();
      p.zremrangebyscore(userKey, "-inf", windowStart);
      p.zremrangebyscore(workspaceKey, "-inf", windowStart);
      p.zcard(userKey);
      p.zcard(workspaceKey);

      let results: Awaited<ReturnType<RedisPipelinePort["exec"]>>;
      try {
        results = await p.exec();
      } catch (err) {
        logger.error({ err, slackUserId }, "rate limiter Redis pipeline threw, failing open");
        return { allowed: true, remaining: -1, resetAt: t + windowMs };
      }
      if (!results) {
        logger.error({ slackUserId }, "rate limiter Redis pipeline returned null, failing open");
        return { allowed: true, remaining: -1, resetAt: t + windowMs };
      }

      const userCount = (results[2][1] as number) ?? 0;
      const workspaceCount = (results[3][1] as number) ?? 0;

      if (userCount >= deps.userPerHour) {
        return { allowed: false, remaining: 0, resetAt: t + windowMs, limitType: "user" };
      }
      if (workspaceCount >= deps.workspacePerHour) {
        return {
          allowed: false,
          remaining: deps.workspacePerHour - workspaceCount,
          resetAt: t + windowMs,
          limitType: "workspace",
        };
      }

      const member = `${t}-${Math.random()}`;
      const p2 = deps.redis.pipeline();
      p2.zadd(userKey, t, member);
      p2.zadd(workspaceKey, t, member);
      p2.expire(userKey, Math.ceil(windowMs / 1000) + 10);
      p2.expire(workspaceKey, Math.ceil(windowMs / 1000) + 10);
      try {
        await p2.exec();
      } catch (err) {
        // The read pipeline already said this request is allowed — don't
        // punish the caller for a transient Redis blip between the two
        // pipelines. Worst case: this request goes uncounted and the user
        // gets one extra query in the current window. Fail-open.
        logger.warn(
          { err, slackUserId },
          "rate limiter write pipeline failed; request allowed anyway",
        );
      }

      return {
        allowed: true,
        remaining: deps.userPerHour - userCount - 1,
        resetAt: t + windowMs,
      };
    },
  };
}
