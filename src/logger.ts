/**
 * Structured JSON logger for Almanac.
 *
 * Trace correlation is pulled from the active OTel span on every log call,
 * so any code running inside `requestContext.run(...)` (or any auto-
 * instrumented http/fetch/aws-sdk span) emits `trace_id` + `span_id` fields
 * that Grafana's Tempo → Loki jump can follow one-click.
 *
 * No AsyncLocalStorage shim: the active-span lookup is the single source of
 * truth for correlation. When no span is active (e.g. startup logs before
 * the first request) the trace fields are omitted, not stubbed.
 */
import pino from "pino";
import { trace } from "@opentelemetry/api";
import { config } from "./config/index.js";

const EMPTY_TRACE_ID = "00000000000000000000000000000000";

function traceFields(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === EMPTY_TRACE_ID) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export const logger = pino(
  {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    base: { service: "almanac" },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: () => traceFields(),
  },
  pino.destination(2),
);
