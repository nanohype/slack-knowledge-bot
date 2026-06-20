/**
 * Audit consumer entrypoint. Long-running k8s Deployment, KEDA-scaled
 * on the audit queue depth via the chart's `aws-sqs-queue` ScaledObject.
 *
 * Reads queue URL + table + bucket from env (set by the chart's Deployment
 * from values.tenantInfra). Constructs the SDK clients once, wires them
 * into `runAuditConsumer` from `src/audit/audit-consumer.ts`, and runs
 * until SIGTERM / SIGINT. A tiny node:http server on PORT (default 3001)
 * exposes /health for k8s probes.
 */

import * as http from "node:http";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import { logger } from "../logger.js";
import { runAuditConsumer } from "../audit/audit-consumer.js";
import { counter } from "../metrics.js";

const PORT = Number.parseInt(process.env["PORT"] ?? "3001", 10);
const AWS_REGION = process.env["AWS_REGION"] ?? "us-west-2";
const queueUrl = process.env["SQS_AUDIT_QUEUE_URL"] ?? "";
const auditTable = process.env["DYNAMODB_TABLE_AUDIT"] ?? "";
const auditBucket = process.env["AUDIT_BUCKET"] ?? "";

for (const [name, value] of Object.entries({
  SQS_AUDIT_QUEUE_URL: queueUrl,
  DYNAMODB_TABLE_AUDIT: auditTable,
  AUDIT_BUCKET: auditBucket,
})) {
  if (!value) {
    logger.error({ envVar: name }, "audit-consumer: required env var is empty, refusing to start");
    process.exit(1);
  }
}

const sqs = new SQSClient({
  region: AWS_REGION,
  requestHandler: new NodeHttpHandler({ requestTimeout: 25_000, connectionTimeout: 1_000 }),
});
const ddb = new DynamoDBClient({
  region: AWS_REGION,
  requestHandler: new NodeHttpHandler({ requestTimeout: 5_000, connectionTimeout: 1_000 }),
});
const s3 = new S3Client({
  region: AWS_REGION,
  requestHandler: new NodeHttpHandler({ requestTimeout: 10_000, connectionTimeout: 1_000 }),
});

let stopping = false;
let loopExited = false;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz" || req.url === "/readyz") {
    res.statusCode = stopping ? 503 : 200;
    res.setHeader("content-type", "application/json");
    res.end(`{"status":"${stopping ? "draining" : "ok"}"}`);
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, "audit-consumer: health server listening");
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, "audit-consumer: shutting down");
  stopping = true;
  // Exit as soon as the receive loop drains — it sees stopping=true once the
  // current long-poll returns (≤20s) and resolves, setting loopExited. The 30s
  // deadline is only a backstop for a hung loop; the chart's
  // terminationGracePeriodSeconds (45s) leaves buffer for the close.
  const deadline = Date.now() + 30_000;
  const drain = setInterval(() => {
    if (loopExited || Date.now() >= deadline) {
      clearInterval(drain);
      server.close();
      process.exit(0);
    }
  }, 500);
  // Hard backstop in case server.close stalls on a keep-alive probe connection.
  setTimeout(() => process.exit(1), 35_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await runAuditConsumer({
  sqs,
  ddb,
  s3,
  queueUrl,
  auditTable,
  auditBucket,
  shouldStop: () => stopping,
  log: (level, msg, ctx) => logger[level](ctx ?? {}, msg),
  onProcessed: (outcome) => counter("AuditConsumerProcessed", 1, { outcome }),
});

loopExited = true;
logger.info("audit-consumer: loop exited, closing http server");
server.close();
process.exit(0);
