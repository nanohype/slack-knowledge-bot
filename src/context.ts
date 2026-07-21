/**
 * Request-scoped tracing context.
 *
 * Correlation IDs thread through logs + metrics via the active OTel span.
 * Auto-instrumentation (loaded at process start via NODE_OPTIONS --require,
 * see Dockerfile) creates spans around http/fetch/aws-sdk hops; this module
 * adds an outer `slack.query` span so every log line in the query pipeline
 * carries the same trace_id without an AsyncLocalStorage shim.
 *
 * `run(ctx, fn)` takes a context whose `traceId` is unused — OTel owns trace
 * IDs. Callers that want a local UUID for user-facing error messages keep
 * their own variable.
 */
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("slack-knowledge-bot");

export interface RequestContext {
  traceId?: string;
}

export const requestContext = {
  run<T>(_ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan("slack.query", async (span: Span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  },
};
