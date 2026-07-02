import { randomUUID } from 'node:crypto';
import { App, AllMiddlewareArgs, SayFn, SlackEventMiddlewareArgs } from '@slack/bolt';
import { requestContext } from '../context.js';
import type { AclGuard } from '../connectors/acl-guard.js';
import { SUPPORTED_SOURCES, type Source } from '../connectors/types.js';
import type { OAuthRouter, TokenStorage } from 'slack-knowledge-bot-oauth';
import type { IdentityResolver } from '../identity/types.js';
import type { RateLimiter } from '../ratelimit/redis-limiter.js';
import type { Retriever } from '../rag/retriever.js';
import type { Generator } from '../rag/generator.js';
import type { AuditLogger } from '../audit/audit-logger.js';
import {
  formatAnswer,
  formatError,
  formatOAuthPrompt,
  formatRateLimitMessage,
} from './formatter.js';
import { buildQueryAuditEvent } from '../audit/audit-logger.js';
import { logger } from '../logger.js';

type BoltClient = AllMiddlewareArgs['client'];

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
      logger.warn({ err, slackUserId }, 'users.info lookup failed');
      return null;
    }
  }

  async function runQuery(args: ProcessQueryArgs & { traceId: string }): Promise<void> {
    const { userId, text, channelId, say, client, ts, traceId } = args;
    const startTime = now();

    const rateResult = await deps.rateLimiter.check(userId, deps.workspaceId);
    if (!rateResult.allowed) {
      const limitType = rateResult.limitType ?? 'user';
      counter('ratelimit.hit', 1, { limit_type: limitType });
      await say({
        ...formatRateLimitMessage(limitType, rateResult.resetAt, {
          userPerHour: deps.userPerHour,
          workspacePerHour: deps.workspacePerHour,
          now,
        }),
        thread_ts: ts,
      });
      return;
    }

    const slackEmail = await getSlackEmail(client, userId);
    if (!slackEmail) {
      await say({
        ...formatError(
          'Could not retrieve your Slack profile email. Make sure your account has a verified email address, then try again.',
          traceId,
        ),
        thread_ts: ts,
      });
      return;
    }
    const identity = await deps.identityResolver.resolveSlackToExternal(userId, slackEmail);
    if (!identity) {
      await say({
        ...formatError(
          'Unable to verify your identity. Ensure your Slack account is linked to your workforce directory.',
          traceId,
        ),
        thread_ts: ts,
      });
      return;
    }

    const presence = await Promise.all(
      SUPPORTED_SOURCES.map(async (source) => {
        const grant = await deps.oauthStorage.get(
          identity.externalUserId,
          deps.sourceToProvider[source],
        );
        return { source, present: grant !== null };
      }),
    );
    const missingTokenSources = presence.filter((p) => !p.present).map((p) => p.source);

    if (missingTokenSources.length === SUPPORTED_SOURCES.length) {
      const authLinks = Object.fromEntries(
        SUPPORTED_SOURCES.map((source) => {
          const provider = deps.sourceToProvider[source];
          const signed = deps.signOAuthStartUrl(identity.externalUserId, provider);
          return [
            source,
            `${deps.appBaseUrl}/oauth/${provider}/start?t=${encodeURIComponent(signed)}`,
          ];
        }),
      ) as Record<Source, string>;
      await say({
        ...formatOAuthPrompt(missingTokenSources, authLinks),
        thread_ts: ts,
      });
      return;
    }

    const queryEmbedding = await deps.retriever.embedQuery(text);
    const rawHits = await deps.retriever.hybridSearch(text, queryEmbedding);

    const verifiedHits = await deps.aclGuard.verify(rawHits, async (source) => {
      try {
        return await deps.oauth.getValidToken(
          identity.externalUserId,
          deps.sourceToProvider[source],
        );
      } catch (err) {
        logger.warn({ err, source, userId: identity.externalUserId }, 'getValidToken failed');
        return null;
      }
    });
    const accessibleHits = verifiedHits.filter((h) => h.accessVerified);
    const redactedHits = verifiedHits.filter((h) => h.wasRedacted);

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

    const auditEvent = buildQueryAuditEvent(
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
    );
    // Blocking await: compliance audit must complete (or its DLQ fallback
    // inside emitQuery must complete) before the query is considered done.
    // The user already saw their answer; the small additional latency is
    // paid here, not in the user-perceptible path.
    try {
      await deps.auditLogger.emitQuery(auditEvent);
    } catch (err) {
      counter('audit.emission_fail');
      logger.error({ err }, 'audit emission failed after blocking await');
    }

    timing('query.latency_ms', latencyMs);
    counter('query.outcome', 1, { outcome: 'success' });
    if (redactedHits.length > 0) counter('redaction.count', redactedHits.length);

    logger.info(
      {
        userId: identity.externalUserId,
        channelId,
        latencyMs,
        citationCount: citations.length,
        redactedCount: redactedHits.length,
      },
      'query processed',
    );
  }

  async function processQuery(args: ProcessQueryArgs): Promise<void> {
    const traceId = randomUUID();
    try {
      await requestContext.run({ traceId }, () => runQuery({ ...args, traceId }));
    } catch (err) {
      counter('query.outcome', 1, { outcome: 'error' });
      throw err;
    }
  }

  async function handleMention({
    event,
    say,
    client,
  }: SlackEventMiddlewareArgs<'app_mention'> & AllMiddlewareArgs): Promise<void> {
    if (!event.user || !event.text) return;
    const queryText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!queryText) {
      await say({
        text: 'Hi! Ask me anything about the knowledge base. Example: `@slack-knowledge-bot What is our vacation policy?`',
        thread_ts: event.ts,
      });
      return;
    }
    await processQuery({
      userId: event.user,
      text: queryText,
      channelId: event.channel ?? '',
      say,
      client,
      ts: event.ts,
    });
  }

  return {
    processQuery,
    async drainInFlight(deadlineMs) {
      if (inFlight.size === 0) return;
      logger.info({ inFlight: inFlight.size }, 'draining in-flight queries before shutdown');
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
      app.event('app_mention', async (args) => {
        await track(handleMention(args));
      });
      app.message(async ({ message, say, client }) => {
        if ((message as { channel_type?: string }).channel_type !== 'im') return;
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
            channelId: msg.channel ?? '',
            say,
            client,
            ts: msg.ts,
          }),
        );
      });
    },
  };
}
