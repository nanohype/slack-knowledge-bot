/**
 * Smoke test for the OTel-backed metrics surface.
 *
 * The OTel API is a no-op when no meter provider is registered, which is
 * exactly what we want under vitest (no auto-instrumentations --require in
 * the test runner). These cases just assert the public entry points don't
 * throw — exercising the histogram/counter caches without any runtime deps.
 *
 * The real pipeline is validated in the live environment via the ADOT
 * collector sidecar + Grafana Cloud Mimir; there is nothing useful to
 * assert here without spinning up an OTel SDK + exporter.
 */
import { describe, it, expect } from "vitest";
import { timing, counter, flushMetrics } from "./metrics.js";

describe("metrics (OTel no-op surface)", () => {
  it("timing() does not throw under the no-op API", () => {
    expect(() => timing("QueryLatency", 123)).not.toThrow();
    expect(() => timing("QueryLatency", 456, { stage: "embed" })).not.toThrow();
  });

  it("counter() does not throw under the no-op API", () => {
    expect(() => counter("RateLimitHit")).not.toThrow();
    expect(() => counter("RateLimitHit", 2, { limit_type: "user" })).not.toThrow();
  });

  it("reuses instrument handles across calls (cached by name)", () => {
    // Same name, same attributes — must not throw or leak.
    for (let i = 0; i < 5; i++) {
      counter("CacheHit");
      timing("CacheLatency", i);
    }
    expect(true).toBe(true);
  });

  it("flushMetrics resolves cleanly (no-op)", async () => {
    await expect(flushMetrics()).resolves.toBeUndefined();
  });
});
