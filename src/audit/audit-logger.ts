/**
 * Audit logger. Emits to SQS (at-least-once) → audit-consumer pod → DDB
 * (90d TTL) + S3 (1y lifecycle). DLQ captures primary-queue failures.
 * PrometheusRule alerts on DLQ depth > 0 (chart/templates/prometheusrule.yaml).
 * Consumer logic lives in src/audit/audit-consumer.ts; the entry binary
 * (src/bin/audit-consumer.js) is what the chart's audit-consumer Deployment
 * runs, KEDA-scaled on the audit queue depth.
 *
 * Two event shapes share the pipeline via a discriminated union on
 * `eventType`:
 *   - "query"       — user asked a question; stores scrubbed query + hit set
 *   - "revocation"  — a grant was revoked (user, offboarding, or
 *                     refresh-failed inside the OAuth module)
 *
 * Query events store scrubbed_query only. Never raw text or source content.
 *
 * Port-injected: takes an `SQSClient` + queue URLs + optional counter
 * hook. Tests use `aws-sdk-client-mock`; production builds one client
 * once in `src/index.ts` and threads it through.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { scrubPii } from './pii-scrubber.js';

export interface QueryAuditEvent {
  eventType: 'query';
  traceId: string;
  userId: string;
  slackUserId: string;
  channelId: string;
  queryHash: string;
  scrubbedQuery: string;
  retrievedDocIds: string[];
  accessibleDocIds: string[];
  redactedDocCount: number;
  answerHash: string;
  latencyMs: number;
  timestamp: string;
  sources: Array<{
    source: 'notion' | 'confluence' | 'drive';
    docId: string;
    url: string;
    lastModified: string;
    wasStale: boolean;
  }>;
}

export interface RevocationAuditEvent {
  eventType: 'revocation';
  traceId?: string;
  userId: string;
  provider: string;
  reason: 'user' | 'offboarding' | 'refresh-failed';
  timestamp: string;
}

export type AuditEvent = QueryAuditEvent | RevocationAuditEvent;

export interface AuditLoggerConfig {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  onCounter?: (metric: string) => void;
  now?: () => number;
}

export interface AuditLogger {
  emitQuery(event: QueryAuditEvent): Promise<void>;
  emitRevocation(
    event: Omit<RevocationAuditEvent, 'eventType' | 'timestamp'> & { timestamp?: string },
  ): Promise<void>;
}

// SQS FIFO caps MessageDeduplicationId at 128 chars. A raw
// `${userId}-${queryHash}-${timestamp}` exceeds that when userIds are
// long (e.g. WorkOS `directory_user_…` = 32+ chars). SHA-256 of the
// raw tuple hex-encodes to 64 chars — stable, well under the cap, and
// still tuple-deterministic so replays dedupe.
function dedupId(event: AuditEvent): string {
  const raw =
    event.eventType === 'query'
      ? `${event.userId}|${event.queryHash}|${event.timestamp}`
      : `${event.userId}|${event.provider}|${event.reason}|${event.timestamp}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function createAuditLogger(deps: AuditLoggerConfig): AuditLogger {
  const counter = deps.onCounter ?? (() => {});
  const now = deps.now ?? (() => Date.now());

  async function emit(event: AuditEvent): Promise<void> {
    const safeEvent =
      event.eventType === 'query'
        ? { ...event, scrubbedQuery: scrubPii(event.scrubbedQuery) }
        : event;
    try {
      await deps.sqs.send(
        new SendMessageCommand({
          QueueUrl: deps.queueUrl,
          MessageBody: JSON.stringify(safeEvent),
          MessageGroupId: event.userId,
          MessageDeduplicationId: dedupId(event),
        }),
      );
      logger.debug({ userId: event.userId, kind: event.eventType }, 'audit event emitted');
    } catch (err) {
      counter('audit.primary_fail');
      logger.error(
        { err, userId: event.userId, kind: event.eventType },
        'failed to emit audit event to SQS',
      );
      try {
        // DLQ is FIFO too (required when the main queue is FIFO), so it
        // needs MessageGroupId + MessageDeduplicationId. Reuse the
        // primary dedupId so a replay doesn't double-count.
        await deps.sqs.send(
          new SendMessageCommand({
            QueueUrl: deps.dlqUrl,
            MessageBody: JSON.stringify({ ...safeEvent, failureReason: String(err) }),
            MessageGroupId: event.userId,
            MessageDeduplicationId: dedupId(event),
          }),
        );
        counter('audit.dlq_write');
      } catch (dlqErr) {
        counter('audit.total_loss');
        logger.error({ dlqErr, userId: event.userId }, 'also failed to write to audit DLQ');
      }
    }
  }

  return {
    async emitQuery(event) {
      return emit(event);
    },
    async emitRevocation(event) {
      return emit({
        eventType: 'revocation',
        timestamp: event.timestamp ?? new Date(now()).toISOString(),
        traceId: event.traceId,
        userId: event.userId,
        provider: event.provider,
        reason: event.reason,
      });
    },
  };
}

/**
 * Pure — no SDK, no port. Builds the event shape from raw inputs,
 * scrubs PII from the query, hashes the query + answer. Kept free of
 * the factory so tests can exercise it directly.
 */
export function buildQueryAuditEvent(
  params: {
    traceId: string;
    userId: string;
    slackUserId: string;
    channelId: string;
    rawQuery: string;
    retrievedDocIds: string[];
    accessibleDocIds: string[];
    redactedDocCount: number;
    answerText: string;
    latencyMs: number;
    sources: QueryAuditEvent['sources'];
  },
  now: () => number = () => Date.now(),
): QueryAuditEvent {
  const scrubbedQuery = scrubPii(params.rawQuery);
  return {
    eventType: 'query',
    traceId: params.traceId,
    userId: params.userId,
    slackUserId: params.slackUserId,
    channelId: params.channelId,
    queryHash: createHash('sha256').update(scrubbedQuery).digest('hex'),
    scrubbedQuery,
    retrievedDocIds: params.retrievedDocIds,
    accessibleDocIds: params.accessibleDocIds,
    redactedDocCount: params.redactedDocCount,
    answerHash: createHash('sha256').update(params.answerText).digest('hex'),
    latencyMs: params.latencyMs,
    timestamp: new Date(now()).toISOString(),
    sources: params.sources,
  };
}
