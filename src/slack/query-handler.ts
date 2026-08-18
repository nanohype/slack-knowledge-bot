import { randomUUID } from "node:crypto";
import type { AllMiddlewareArgs, App, SayFn, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { OAuthRouter, TokenStorage } from "slack-knowledge-bot-oauth";
import type { AuditLogger } from "../audit/audit-logger.js";
import { buildQueryAuditEvent } from "../audit/audit-logger.js";
import type { AclGuard } from "../connectors/acl-guard.js";
import { type Source, SUPPORTED_SOURCES } from "../connectors/types.js";
import { requestContext } from "../context.js";
import type { IdentityResolver } from "../identity/types.js";
import { logger } from "../logger.js";
import type { Generator } from "../rag/generator.js";
import type { Retriever } from "../rag/retriever.js";
import type { RateLimiter } from "../ratelimit/redis-limiter.js";
import {
  formatAnswer,
  formatError,
  formatOAuthPrompt,
  formatRateLimitMessage,
} from "./formatter.js";

type BoltClient = AllMiddlewareArgs["client"];

const EMAIL_CACHE_TTL_MS = 5 * 60 * 1000;
// Bound the per-process email cache so a churn of distinct Slack users can't
// grow it without limit. Oldest insertion is evicted at the cap (the Map
// preserves insertion order); expired entries are dropped on read.
const EMAIL_CACHE_MAX = 10_000;

export interface QueryHandlerConfig {
  rateLimiter: RateLimiter;
  identityResolver: IdentityResolver;
  retriever: Retriever;
  aclGuard: AclGuard;
  generator: Generator;
  auditLogger: AuditLogger;
  oauth: OAuthRouter;
  oauthStorage: TokenStorage;
  signOAuthStartUrl: (userId: string, provider: string) => string;
  sourceToProvider: Record<Source, string>;
  workspaceId: string;
  appBaseUrl: string;
  userPerHour: number;
  workspacePerHour: number;
  onCounter?: (metric: string, value?: number, dims?: Record<string, string>) => void;
  onTiming?: (metric: string, ms: number) => void;
  now?: () => number;
}

export interface ProcessQueryArgs {
  userId: string;
  text: string;
  channelId: string;
  say: SayFn;
  client: BoltClient;
  ts?: string;
}

export interface QueryHandler {
  registerWith(app: App): void;
  processQuery(args: ProcessQueryArgs): Promise<void>;
  /**
   * Await in-flight queries registered via {@link registerWith}, bounded by
   * `deadlineMs`. Called on SIGTERM so a shutdown mid-query doesn't drop the
   * awaited compliance audit. Returns immediately when nothing is in flight.
   */
  drainInFlight(deadlineMs: number): Promise<void>;
}

export function createQueryHandler(deps: QueryHandlerConfig): QueryHandler {
  const now = deps.now ?? (() => Date.now());
  const counter = deps.onCounter ?? (() => {});
  const timing = deps.onTiming ?? (() => {});
  const emailCache = new Map<string, { email: string; expiresAt: number }>();
  const inFlight = new Set<Promise<unknown>>();

  function track(p: Promise<unknown>): Promise<unknown> {
    inFlight.add(p);
    // Bookkeeping only — the `.catch` keeps the finally-derived chain from
    // surfacing as an unhandled rejection when a handler rejects. The caller
    // awaits the original `p`, so handler errors still propagate to Bolt.
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  }

  async function getSlackEmail(client: BoltClient, slackUserId: string): Promise<string | null> {
    const t = now();
    const cached = emailCache.get(slackUserId);
    if (cached) {
      if (cached.expiresAt > t) return cached.email;
      emailCache.delete(slackUserId); // drop expired so it can't pin a slot
    }
    try {
      const result = await client.users.info({ user: slackUserId });
      const email = result.user?.profile?.email ?? null;
      if (email) {
        if (emailCache.size >= EMAIL_CACHE_MAX) {
          const oldest = emailCache.keys().next().value;
          if (oldest !== undefined) emailCache.delete(oldest);
        }
        emailCache.set(slackUserId, { email, expiresAt: t + EMAIL_CACHE_TTL_MS });
      }
      return email;
    } catch (err) {
      logger.warn({ err, slackUserId }, "users.info lookup failed");
      return null;
    }
  }

  /**
   * Rate limit. Replies with the limit message and returns false when the
   * caller is over; the caller returns without touching retrieval.
   */
  async function passesRateLimit(userId: string, say: SayFn, ts?: string): Promise<boolean> {
    const rateResult = await deps.rateLimiter.check(userId, deps.workspaceId);
    if (rateResult.allowed) return true;

    const limitType = rateResult.limitType ?? "user";
    counter("ratelimit.hit", 1, { limit_type: limitType });
    await say({
      ...formatRateLimitMessage(limitType, rateResult.resetAt, {
        userPerHour: deps.userPerHour,
        workspacePerHour: deps.workspacePerHour,
        now,
      }),
      thread_ts: ts,
    });
    return false;
  }

  /**
   * Slack user -> workforce-directory identity, via the profile email.
   *
   * Two distinct failures with two distinct messages: no verified Slack email,
   * and an email the directory does not know. Both reply and return null —
   * every downstream ACL probe is scoped to this identity, so there is no
   * meaningful "continue without it".
   */
  async function resolveIdentity(
    client: BoltClient,
    userId: string,
    say: SayFn,
    traceId: string,
    ts?: string,
  ) {
    const slackEmail = await getSlackEmail(client, userId);
    if (!slackEmail) {
      await say({
        ...formatError(
          "Could not retrieve your Slack profile email. Make sure your account has a verified email address, then try again.",
          traceId,
        ),
        thread_ts: ts,
      });
      return null;
    }

    const identity = await deps.identityResolver.resolveSlackToExternal(userId, slackEmail);
    if (!identity) {
      await say({
        ...formatError(
          "Unable to verify your identity. Ensure your Slack account is linked to your workforce directory.",
          traceId,
        ),
        thread_ts: ts,
      });
      return null;
    }
    return identity;
  }

  /**
   * OAuth token presence, checked before any retrieval work.
   *
   * Only a caller missing *every* source gets the connect prompt — a partial
   * grant still answers over what they have connected, which is the whole
   * point of per-user ACL. Presence only; validity is the ACL guard's job.
   */
  async function passesTokenPresence(
    externalUserId: string,
    say: SayFn,
    ts?: string,
  ): Promise<boolean> {
    const presence = await Promise.all(
      SUPPORTED_SOURCES.map(async (source) => {
        const grant = await deps.oauthStorage.get(externalUserId, deps.sourceToProvider[source]);
        return { source, present: grant !== null };
      }),
    );
    const missingTokenSources = presence.filter((p) => !p.present).map((p) => p.source);
    if (missingTokenSources.length < SUPPORTED_SOURCES.length) return true;

    const authLinks = Object.fromEntries(
      SUPPORTED_SOURCES.map((source) => {
        const provider = deps.sourceToProvider[source];
        const signed = deps.signOAuthStartUrl(externalUserId, provider);
        return [
          source,
          `${deps.appBaseUrl}/oauth/${provider}/start?t=${encodeURIComponent(signed)}`,
        ];
      }),
    ) as Record<Source, string>;
    await say({ ...formatOAuthPrompt(missingTokenSources, authLinks), thread_ts: ts });
    return false;
  }

  /**
   * Retrieve, then verify each hit against the asking user's own tokens.
   *
   * The ACL check runs *after* retrieval and is the anti-leak boundary: a
   * document that scored well is dropped unless this user can read it in the
   * source system. `getValidToken` failing is not fatal here — the guard
   * fail-secures on a null token, so a token error redacts the document
   * rather than answering from it.
   */
  async function retrieveVerified(text: string, externalUserId: string) {
    const queryEmbedding = await deps.retriever.embedQuery(text);
    const rawHits = await deps.retriever.hybridSearch(text, queryEmbedding);

    const verifiedHits = await deps.aclGuard.verify(rawHits, async (source) => {
      try {
        return await deps.oauth.getValidToken(externalUserId, deps.sourceToProvider[source]);
      } catch (err) {
        logger.warn({ err, source, userId: externalUserId }, "getValidToken failed");
        return null;
      }
    });

    return {
      rawHits,
      verifiedHits,
      accessibleHits: verifiedHits.filter((h) => h.accessVerified),
      redactedHits: verifiedHits.filter((h) => h.wasRedacted),
    };
  }

  /**
   * Blocking compliance audit.
   *
   * Awaited, not fire-and-forget: the query is not done until the event (or
   * its DLQ fallback inside emitQuery) has landed. The user already has their
   * answer, so the latency is paid here rather than in the visible path. A
   * failure past the fallback is counted and logged, never swallowed.
   */
  async function emitAudit(event: ReturnType<typeof buildQueryAuditEvent>): Promise<void> {
    try {
      await deps.auditLogger.emitQuery(event);
    } catch (err) {
      counter("audit.emission_fail");
      logger.error({ err }, "audit emission failed after blocking await");
    }
  }

  async function runQuery(args: ProcessQueryArgs & { traceId: string }): Promise<void> {
    const { userId, text, channelId, say, client, ts, traceId } = args;
    const startTime = now();

    if (!(await passesRateLimit(userId, say, ts))) return;

    const identity = await resolveIdentity(client, userId, say, traceId, ts);
    if (!identity) return;

    if (!(await passesTokenPresence(identity.externalUserId, say, ts))) return;

    const { rawHits, verifiedHits, accessibleHits, redactedHits } = await retrieveVerified(
      text,
      identity.externalUserId,
    );

    const { answerText, citations, hasRedactedHits } = await deps.generator.generate(
      text,
      verifiedHits,
      redactedHits.length > 0,
    );

    await say({
      ...formatAnswer(answerText, citations, hasRedactedHits, accessibleHits.length === 0),
      thread_ts: ts,
    });

    const latencyMs = now() - startTime;

    await emitAudit(
      buildQueryAuditEvent(
        {
          traceId,
          userId: identity.externalUserId,
          slackUserId: userId,
          channelId,
          rawQuery: text,
          retrievedDocIds: rawHits.map((h) => h.docId),
          accessibleDocIds: accessibleHits.map((h) => h.docId),
          redactedDocCount: redactedHits.length,
          answerText,
          latencyMs,
          sources: citations.map((c) => ({
            source: c.source,
            docId: c.docId,
            url: c.url,
            lastModified: c.lastModified,
            wasStale: c.isStale,
          })),
        },
        now,
      ),
    );

    timing("query.latency_ms", latencyMs);
    counter("query.outcome", 1, { outcome: "success" });
    if (redactedHits.length > 0) counter("redaction.count", redactedHits.length);

    logger.info(
      {
        userId: identity.externalUserId,
        channelId,
        latencyMs,
        citationCount: citations.length,
        redactedCount: redactedHits.length,
      },
      "query processed",
    );
  }
  async function processQuery(args: ProcessQueryArgs): Promise<void> {
    const traceId = randomUUID();
    try {
      await requestContext.run({ traceId }, () => runQuery({ ...args, traceId }));
    } catch (err) {
      counter("query.outcome", 1, { outcome: "error" });
      throw err;
    }
  }

  async function handleMention({
    event,
    say,
    client,
  }: SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs): Promise<void> {
    if (!event.user || !event.text) return;
    const queryText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!queryText) {
      await say({
        text: "Hi! Ask me anything about the knowledge base. Example: `@slack-knowledge-bot What is our vacation policy?`",
        thread_ts: event.ts,
      });
      return;
    }
    await processQuery({
      userId: event.user,
      text: queryText,
      channelId: event.channel ?? "",
      say,
      client,
      ts: event.ts,
    });
  }

  return {
    processQuery,
    async drainInFlight(deadlineMs) {
      if (inFlight.size === 0) return;
      logger.info({ inFlight: inFlight.size }, "draining in-flight queries before shutdown");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref();
      });
      try {
        await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    registerWith(app) {
      app.event("app_mention", async (args) => {
        await track(handleMention(args));
      });
      app.message(async ({ message, say, client }) => {
        if ((message as { channel_type?: string }).channel_type !== "im") return;
        if ((message as { subtype?: string }).subtype) return;
        const msg = message as {
          text?: string;
          user?: string;
          channel?: string;
          ts?: string;
        };
        if (!msg.text || !msg.user) return;
        await track(
          processQuery({
            userId: msg.user,
            text: msg.text,
            channelId: msg.channel ?? "",
            say,
            client,
            ts: msg.ts,
          }),
        );
      });
    },
  };
}
