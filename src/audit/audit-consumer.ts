/**
 * Audit consumer — long-running SQS poller that drains the audit queue into
 * DynamoDB (90d TTL) + S3 (1y lifecycle). Runs as the KEDA-scaled
 * audit-consumer Deployment.
 *
 * Strict validation contract: every interpolated field gets regex-checked
 * against tight character classes before any storage write.
 * Failures fall into two buckets:
 *
 *   - Malformed event (bad JSON, regex mismatch) → drop the message
 *     (deletes from queue). These are poison records; retrying just
 *     occupies the visibility window. DLQ doesn't help if the same shape
 *     can never succeed.
 *
 *   - Transient write error (DDB throttle, S3 5xx, network blip) → do NOT
 *     delete the message. The visibility timeout expires, the message
 *     reappears, the consumer retries. After maxReceiveCount, SQS moves
 *     the message to the DLQ. `AuditTotalLoss` only fires if BOTH the
 *     primary and DLQ writes failed at the producer side.
 *
 * Port-injected for testability: SDK clients + queue URL + table/bucket
 * names + a `shouldStop` callback come from the constructor.
 */

import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

const RE_USER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_QUERY_HASH = /^[A-Za-z0-9]{1,128}$/;
const TTL_SECONDS = 90 * 24 * 3600;

export interface AuditConsumerDeps {
  sqs: SQSClient;
  ddb: DynamoDBClient;
  s3: S3Client;
  queueUrl: string;
  auditTable: string;
  auditBucket: string;
  /**
   * Returns true when the consumer should exit its receive loop. Wired to a
   * SIGTERM-flipped flag in `src/bin/audit-consumer.ts`; in tests, can be
   * driven by a counter so the loop exits after N iterations.
   */
  shouldStop: () => boolean;
  /**
   * Optional structured-log hook. The default is a no-op so unit tests
   * don't need to wire pino.
   */
  log?: (level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Optional counter hook for metrics emission. Called with the outcome
   * tag for every processed message.
   */
  onProcessed?: (outcome: "ok" | "dropped_malformed" | "dropped_invalid_shape" | "retry") => void;
}

interface ValidEvent {
  userId: string;
  timestamp: string;
  queryHash: string;
  datePart: string;
}

const noopLog: NonNullable<AuditConsumerDeps["log"]> = () => undefined;

function validateEvent(raw: unknown): ValidEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const userId = typeof obj["userId"] === "string" ? obj["userId"] : "";
  const timestamp = typeof obj["timestamp"] === "string" ? obj["timestamp"] : "";
  const queryHash = typeof obj["queryHash"] === "string" ? obj["queryHash"] : "";
  const datePart = timestamp.split("T")[0] ?? "";
  if (!RE_USER_ID.test(userId)) return null;
  if (!RE_ISO_DATE.test(datePart)) return null;
  if (!RE_QUERY_HASH.test(queryHash)) return null;
  return { userId, timestamp, queryHash, datePart };
}

async function writeToDdb(deps: AuditConsumerDeps, event: ValidEvent, raw: string): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  await deps.ddb.send(
    new PutItemCommand({
      TableName: deps.auditTable,
      Item: {
        userId: { S: event.userId },
        timestamp: { S: event.timestamp },
        eventData: { S: raw },
        ttl: { N: String(ttl) },
      },
    }),
  );
}

async function writeToS3(deps: AuditConsumerDeps, event: ValidEvent, raw: string): Promise<void> {
  const key = `audit/${event.userId}/${event.datePart}/${event.queryHash}.json`;
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.auditBucket,
      Key: key,
      Body: raw,
      ContentType: "application/json",
    }),
  );
}

async function deleteMessage(deps: AuditConsumerDeps, receiptHandle: string): Promise<void> {
  await deps.sqs.send(
    new DeleteMessageCommand({
      QueueUrl: deps.queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  );
}

/**
 * Long-poll the audit queue until `shouldStop()` returns true. Each
 * iteration receives up to 10 messages (the SQS batch maximum) with a
 * 20-second long-poll window, processes them concurrently, and starts
 * over.
 */
export async function runAuditConsumer(deps: AuditConsumerDeps): Promise<void> {
  const log = deps.log ?? noopLog;
  const onProcessed = deps.onProcessed;

  log("info", "audit-consumer: started", { queueUrl: deps.queueUrl });

  while (!deps.shouldStop()) {
    let result;
    try {
      result = await deps.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: deps.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 60,
        }),
      );
    } catch (err) {
      log("error", "audit-consumer: receive failed, backing off", { err });
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }

    const messages = result.Messages ?? [];
    if (messages.length === 0) continue;

    await Promise.allSettled(
      messages.map(async (msg) => {
        const receiptHandle = msg.ReceiptHandle;
        const body = msg.Body;
        if (!receiptHandle || !body) {
          log("warn", "audit-consumer: message missing handle/body, skipping", {
            messageId: msg.MessageId,
          });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          log("warn", "audit-consumer: malformed JSON, dropping", { messageId: msg.MessageId });
          onProcessed?.("dropped_malformed");
          await deleteMessage(deps, receiptHandle);
          return;
        }

        const event = validateEvent(parsed);
        if (!event) {
          log("warn", "audit-consumer: invalid field shape, dropping", {
            messageId: msg.MessageId,
          });
          onProcessed?.("dropped_invalid_shape");
          await deleteMessage(deps, receiptHandle);
          return;
        }

        try {
          await writeToDdb(deps, event, body);
          await writeToS3(deps, event, body);
          await deleteMessage(deps, receiptHandle);
          onProcessed?.("ok");
        } catch (err) {
          // Don't delete — visibility window expires, SQS reappears the
          // message, we retry. After maxReceiveCount on the queue
          // configuration, SQS moves it to the DLQ.
          log("error", "audit-consumer: write failed, will retry", {
            messageId: msg.MessageId,
            err: err instanceof Error ? err.message : String(err),
          });
          onProcessed?.("retry");
        }
      }),
    );
  }

  log("info", "audit-consumer: shouldStop() returned true, exiting loop");
}
