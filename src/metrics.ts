/**
 * Application metrics via the OTel Metrics API.
 *
 * Exports via OTLP to the grafana-agent receiver
 * (grafana-agent.monitoring.svc.cluster.local:4318), which forwards metrics to
 * Amazon Managed Prometheus. The meter provider is bootstrapped by
 * `@opentelemetry/auto-instrumentations-node/register` (NODE_OPTIONS in the
 * Dockerfile) plus OTEL_METRICS_EXPORTER=otlp wired into the pod env by the chart.
 *
 * Public surface: `timing` → histogram (ms); `counter` → monotonic counter.
 * `flushMetrics` is a no-op —
 * the SDK batches + flushes on its own schedule, and shutdown is already
 * handled by the OTel exporter.
 *
 * When no meter provider is registered (e.g. in vitest without the auto-
 * instrumentations --require hook), the OTel API degrades to a no-op. That's
 * intentional: tests don't need a mock metrics backend, and adding one would
 * just re-assert the SDK's own contract.
 */
import { metrics as otelMetrics, type Counter, type Histogram } from '@opentelemetry/api';

const METER_NAME = 'slack-knowledge-bot';

// Self-prefix every instrument with the service namespace so the Prometheus
// series are deterministic — `query.latency_ms` becomes
// `slack_knowledge_bot_query_latency_ms_bucket` purely from the instrument name
// (OTLP→Prometheus lowercases dots to underscores + adds the type suffix), with
// no dependency on a collector-side namespace rewrite.
const NAMESPACE = 'slack_knowledge_bot';
const qualify = (name: string): string => `${NAMESPACE}.${name}`;

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

function getCounter(name: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = otelMetrics.getMeter(METER_NAME).createCounter(qualify(name));
    counters.set(name, c);
  }
  return c;
}

function getHistogram(name: string): Histogram {
  let h = histograms.get(name);
  if (!h) {
    h = otelMetrics.getMeter(METER_NAME).createHistogram(qualify(name), { unit: 'ms' });
    histograms.set(name, h);
  }
  return h;
}

export function timing(name: string, ms: number, dimensions?: Record<string, string>): void {
  getHistogram(name).record(ms, dimensions);
}

export function counter(name: string, value = 1, dimensions?: Record<string, string>): void {
  getCounter(name).add(value, dimensions);
}

/**
 * Flush hook retained for shutdown compatibility. The OTel SDK owns its
 * own batching + export cadence; no app-side flush is required.
 */
export function flushMetrics(): Promise<void> {
  return Promise.resolve();
}
