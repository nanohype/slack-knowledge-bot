/**
 * SlackKnowledgeBot bootstrap.
 *
 * Builds every external-IO client once (Redis, SQS, DDB, Bedrock, the
 * retrieval backend, OAuth router) and hands them to the service
 * factories. Everything downstream — query handler, disconnect
 * command, OAuth routes — runs against port interfaces, so the same
 * factories can be re-wired for a different client's stack by
 * swapping the SDK clients built here.
 */
import { App } from "@slack/bolt";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Pool } from "pg";
import http from "node:http";
import { config } from "./config/index.js";
import { createRateLimiter } from "./ratelimit/redis-limiter.js";
import { createWorkOSResolver } from "./identity/workos-resolver.js";
import { createAclGuard } from "./connectors/acl-guard.js";
import { createRetriever } from "./rag/retriever.js";
import { createNullBackend } from "./rag/backends/null.js";
import { createPgvectorBackend } from "./rag/backends/pgvector.js";
import { initSchema } from "./rag/backends/pgvector-schema.js";
import type { RetrievalBackend } from "./rag/backends/types.js";
import { createGenerator } from "./rag/generator.js";
import { createAuditLogger } from "./audit/audit-logger.js";
import { createQueryHandler } from "./slack/query-handler.js";
import { createDisconnectCommand } from "./slack/disconnect-command.js";
import { createSlackKnowledgeBotOAuth, SOURCE_TO_PROVIDER } from "./oauth/router.js";
import { signOAuthStartUrl } from "./oauth/url-token.js";
import { nodeReqToWebRequest, writeWebResponse } from "./oauth/http.js";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { counter, timing, flushMetrics } from "./metrics.js";

const TITAN_EMBEDDING_DIM = 1024;

const redis = getRedis();
const sqs = new SQSClient({
  region: config.AWS_REGION,
  requestHandler: new NodeHttpHandler({ requestTimeout: 3000, connectionTimeout: 1000 }),
});
const ddb = new DynamoDBClient({
  region: config.AWS_REGION,
  requestHandler: new NodeHttpHandler({ requestTimeout: 5000, connectionTimeout: 1000 }),
});
const bedrock = new BedrockRuntimeClient({
  region: config.BEDROCK_REGION,
  // SDK-layer timeouts backstop the application-level AbortSignal.timeout in
  // retriever/generator. A stalled TCP connection that never errors would
  // otherwise hold the Bolt handler slot until Node's default socket timeout.
  requestHandler: new NodeHttpHandler({
    requestTimeout: 35_000,
    connectionTimeout: 2_000,
  }),
});

// Retrieval backend — scheme-dispatched from a single URL.
//   explicit RETRIEVAL_BACKEND_URL takes precedence
//   PG* fields (injected into the pod env from Aurora + the
//     ExternalSecret-synced DB credentials) compose a postgresql://
//     URL when RETRIEVAL_BACKEND_URL is blank
//   neither set → null backend
//   unsupported scheme → hard fail at startup
const retrievalBackend: RetrievalBackend = buildRetrievalBackend();

function composePgUrlFromEnv(): string {
  if (!config.PGHOST || !config.PGUSER || !config.PGPASSWORD) return "";
  const host = config.PGHOST;
  const port = config.PGPORT;
  const user = encodeURIComponent(config.PGUSER);
  const pw = encodeURIComponent(config.PGPASSWORD);
  const db = config.PGDATABASE;
  return `postgresql://${user}:${pw}@${host}:${port}/${db}`;
}

function buildRetrievalBackend(): RetrievalBackend {
  const url = config.RETRIEVAL_BACKEND_URL || composePgUrlFromEnv();
  if (!url) {
    logger.info("No retrieval backend configured — using null backend");
    return createNullBackend();
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    // RDS Postgres enforces TLS (rds.force_ssl=1 in the default parameter
    // group). `rejectUnauthorized: false` accepts the AWS-managed cert
    // without bundling the RDS CA chain — the connection is still
    // encrypted, only the cert-authority pinning is relaxed.
    const pool = new Pool({
      connectionString: url,
      max: 5,
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", (err) => logger.error({ err }, "pgvector pool error"));
    // Idempotent schema init. If the DB is unreachable on boot, log and
    // let the retriever error out at query time until it's fixed — no
    // reason to crash the task.
    void initSchema({ query: pool, embeddingDim: TITAN_EMBEDDING_DIM }).catch((err) =>
      logger.error({ err }, "pgvector schema init failed; retrieval will error until fixed"),
    );
    return createPgvectorBackend({ query: pool, embeddingDim: TITAN_EMBEDDING_DIM });
  }
  throw new Error(
    `Unsupported RETRIEVAL_BACKEND_URL scheme: ${url}. Expected empty, postgres://, or postgresql://.`,
  );
}

const auditLogger = createAuditLogger({
  sqs,
  queueUrl: config.SQS_AUDIT_QUEUE_URL,
  dlqUrl: config.SQS_AUDIT_DLQ_URL,
  onCounter: counter,
});

const identityResolver = createWorkOSResolver({
  fetchImpl: fetch,
  ddbClient: ddb,
  workosApiKey: config.WORKOS_API_KEY,
  workosDirectoryId: config.WORKOS_DIRECTORY_ID,
  identityCacheTable: config.DYNAMODB_TABLE_IDENTITY_CACHE,
});

const rateLimiter = createRateLimiter({
  redis,
  userPerHour: config.RATE_LIMIT_USER_PER_HOUR,
  workspacePerHour: config.RATE_LIMIT_WORKSPACE_PER_HOUR,
});

const retriever = createRetriever({
  backend: retrievalBackend,
  bedrock,
  embeddingModelId: config.BEDROCK_EMBEDDING_MODEL_ID,
  onTiming: timing,
  onCounter: counter,
});

const generator = createGenerator({
  bedrock,
  llmModelId: config.BEDROCK_LLM_MODEL_ID,
  staleThresholdDays: config.STALE_DOC_THRESHOLD_DAYS,
  onCounter: counter,
  onTiming: timing,
});

const aclGuard = createAclGuard({ fetchImpl: fetch, onCounter: counter });

const { router: oauth, storage: oauthStorage } = createSlackKnowledgeBotOAuth({ auditLogger });

const queryHandler = createQueryHandler({
  rateLimiter,
  identityResolver,
  retriever,
  aclGuard,
  generator,
  auditLogger,
  oauth,
  oauthStorage,
  signOAuthStartUrl,
  sourceToProvider: SOURCE_TO_PROVIDER,
  workspaceId: "slack-knowledge-bot",
  appBaseUrl: config.APP_BASE_URL,
  userPerHour: config.RATE_LIMIT_USER_PER_HOUR,
  workspacePerHour: config.RATE_LIMIT_WORKSPACE_PER_HOUR,
  onCounter: counter,
  onTiming: timing,
});

const disconnectCommand = createDisconnectCommand({
  identityResolver,
  oauth,
  sourceToProvider: SOURCE_TO_PROVIDER,
});

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  signingSecret: config.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: config.SLACK_APP_TOKEN,
});

queryHandler.registerWith(app);
disconnectCommand.registerWith(app);

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "slack-knowledge-bot" }));
      return;
    }

    if (req.url?.startsWith("/oauth/")) {
      const webReq = await nodeReqToWebRequest(req);
      const url = new URL(webReq.url);
      if (url.pathname.endsWith("/start")) {
        return writeWebResponse(res, await oauth.handlers.start(webReq));
      }
      if (url.pathname.endsWith("/callback")) {
        return writeWebResponse(res, await oauth.handlers.callback(webReq));
      }
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    logger.error({ err, url: req.url }, "http handler threw");
    res.writeHead(500);
    res.end();
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  try {
    await flushMetrics();
  } catch (err) {
    logger.error({ err }, "metrics flush on shutdown failed");
  }
  try {
    await app.stop();
  } catch (err) {
    logger.error({ err }, "bolt stop failed");
  }
  httpServer.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Bolt's Socket Mode client reconnects in a detached promise — a bad
// SLACK_APP_TOKEN throws from there, not from `await app.start()`. Node's
// default unhandled-rejection behavior is to crash the process, which
// crash-loops the pod before an operator can rotate secrets. Log and keep
// serving /health + /oauth/* so the pod stays healthy and probes pass.
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "unhandledRejection (swallowed to keep task alive)");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException (swallowed to keep task alive)");
});

(async () => {
  httpServer.listen(3001);
  try {
    await app.start();
    logger.info({ env: config.NODE_ENV }, "SlackKnowledgeBot is running");
  } catch (err) {
    // Bolt (Socket Mode) auth failure — usually a bad SLACK_APP_TOKEN or a
    // transient Slack outage. Keep the HTTP server up so /health and
    // /oauth/* routes continue serving; operators can update the
    // Secrets Manager value and restart the Deployment without the
    // container crashing and crash-looping the pod.
    logger.error({ err }, "Bolt start failed; HTTP server still up for /health");
  }
})();
