/**
 * Application metrics via the OTel Metrics API.
 *
 * Exports via OTLP to the grafana-agent receiver
 * (grafana-agent.monitoring.svc.cluster.local:4318), which forwards metrics to
 * Amazon Managed Prometheus. The meter provider is bootstrapped by
 * `@opentelemetry/auto-instrumentations-node/register` (NODE_OPTIONS in the
 * Dockerfile) plus OTEL_METRICS_EXPORTER=otlp wired into the pod env by the chart.
 *
 * The lazy-instrument core (namespace qualification — `query.latency_ms`
 * becomes `slack_knowledge_bot_query_latency_ms_bucket` purely from the
 * instrument name — per-name caching, no-op degradation without a provider)
 * is the vendored `@nanohype/runtime` metrics module; this file is the app's
 * surface over it: `timing` → histogram (ms); `counter` → monotonic counter.
 * `flushMetrics` is a no-op — the SDK batches + flushes on its own schedule,
 * and shutdown is already handled by the OTel exporter.
 */
import { createMetrics } from './vendor/runtime/metrics.js';

const metrics = createMetrics({
  meterName: 'slack-knowledge-bot',
  namespace: 'slack_knowledge_bot',
});

export function timing(name: string, ms: number, dimensions?: Record<string, string>): void {
  metrics.timing(name, ms, dimensions);
}

export function counter(name: string, value = 1, dimensions?: Record<string, string>): void {
  metrics.counter(name, value, dimensions);
}

/**
 * Flush hook retained for shutdown compatibility. The OTel SDK owns its
 * own batching + export cadence; no app-side flush is required.
 */
export function flushMetrics(): Promise<void> {
  return Promise.resolve();
}
