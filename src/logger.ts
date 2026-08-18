/**
 * Structured JSON logger for SlackKnowledgeBot.
 *
 * Trace correlation is pulled from the active OTel span on every log call,
 * so any code running inside `requestContext.run(...)` (or any auto-
 * instrumented http/fetch/aws-sdk span) emits `trace_id` + `span_id` fields
 * that Grafana's Tempo → Loki jump can follow one-click.
 *
 * No AsyncLocalStorage shim: the active-span lookup is the single source of
 * truth for correlation. When no span is active (e.g. startup logs before
 * the first request) the trace fields are omitted, not stubbed.
 *
 * Reads its two env vars directly rather than importing the app config, and
 * that is load-bearing rather than a shortcut. Every module imports this one,
 * including `src/bin/audit-consumer.ts` — a second entrypoint whose Deployment
 * ships ten env vars and no secret. `config/index.ts` calls `process.exit(1)`
 * at module scope on a failed parse, so importing it here made the audit
 * consumer exit 1 on ~25 missing app values before reaching any of its own
 * logic. A logger needs a level; it does not need the Slack tokens.
 * `src/logger.import-graph.test.ts` holds this line.
 */

import { trace } from "@opentelemetry/api";
import pino from "pino";

const EMPTY_TRACE_ID = "00000000000000000000000000000000";

// Structurally enforce "tokens/secrets never in logs" — the same invariant the
// OAuth module's recursive redactor protects (packages/oauth/src/oauth/logger.ts).
// Covers the realistic shapes the app actually logs: bare token fields, and the
// nested header/config shapes carried by attached fetch/SDK errors.
const REDACT_PATHS = [
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "token",
  "code",
  "codeVerifier",
  "code_verifier",
  "clientSecret",
  "client_secret",
  "password",
  "secret",
  "apiKey",
  "authorization",
  "Authorization",
  "*.accessToken",
  "*.refreshToken",
  "*.access_token",
  "*.refresh_token",
  "*.token",
  "*.clientSecret",
  "*.client_secret",
  "*.authorization",
  "*.Authorization",
  "headers.authorization",
  "headers.Authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.Authorization",
  "*.headers.cookie",
  "err.config.headers.authorization",
  "err.config.headers.Authorization",
  "err.response.config.headers.authorization",
  "err.request.headers.authorization",
];

function traceFields(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === EMPTY_TRACE_ID) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

// pino throws on an unrecognised level, which would turn a typo in a chart
// value into a crash-looping pod. Unknown values fall back to the NODE_ENV
// default instead — the level is an operational dial, not a safety control,
// and there is no logger yet to warn through.
const PINO_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

function resolveLevel(): string {
  const fallback = process.env.NODE_ENV === "production" ? "info" : "debug";
  const requested = process.env.LOG_LEVEL;
  return requested && PINO_LEVELS.has(requested) ? requested : fallback;
}

export const logger = pino(
  {
    level: resolveLevel(),
    base: { service: "slack-knowledge-bot" },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: () => traceFields(),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  },
  pino.destination(2),
);
