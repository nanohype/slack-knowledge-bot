import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // MODEL_GATEWAY_ENDPOINT has no default in config, by design: the operator
    // derives it from the Platform name, so there is no sensible one to guess.
    // Supplied here so every suite that loads the config can start.
    env: {
      MODEL_GATEWAY_ENDPOINT: "http://gw.tenants-x.svc.cluster.local:8080",
    },
    globals: true,
    environment: "node",
    // evals/*.test.ts is the offline half of the eval tier — fixture
    // validity and the graders. It runs here, on every PR, because the model
    // half can be skipped and a rotted golden set must not wait for it.
    // The model half is evals/*.eval.ts, on its own config (npm run eval).
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // bootstrap; only verifiable in real-Slack integration
        "src/bin/audit-consumer.ts", // KEDA-scaled entry binary; process/signal wiring, only verifiable in real integration
        "src/redis.ts", // ioredis client factory; connects on construction, only verifiable against a real Redis
        "src/connectors/types.ts", // type declarations only
        "src/scripts/**", // one-off dev seeders; run via `kubectl exec`, not in-app
        "src/rag/backends/pgvector-schema.ts", // DDL bootstrap; exercised by RDS at deploy time
        "src/oauth/router.ts", // OAuth wiring; exercised by the real provider handshake (integration only)
        "src/oauth/http.ts", // node:http ↔ Web Request bridge; covered end-to-end by smoke test
        "src/vendor/**", // vendored from nanohype library/runtime — unit-tested upstream; byte-identity enforced by scripts/sync-vendored.mjs --check
        "src/test-setup.ts",
        "src/**/*.test.ts",
      ],
      thresholds: {
        // The org floor (nanohype/standards/testing-rubric.json). Measured well
        // above it — 93.22 / 84.08 / 93.70 / 95.20 — so this is the bar, not a
        // ratchet.
        branches: 60,
        functions: 75,
        lines: 75,
        statements: 75,

        // Per-file 100% on the security- and compliance-critical path, above the
        // global floor. A global floor averages these files with everything
        // around them, so the package can sit comfortably above 75 while an
        // uncovered branch in the ACL check ships — and on these files a branch
        // that was never taken in a test is a control that was never proven.
        //
        // Raising one of these is a decision about what the product guarantees,
        // not a coverage adjustment.

        // The anti-leak boundary. Every fail-secure arm — no verifier, no token,
        // probe error, open breaker — must be exercised, because each one is the
        // difference between dropping a document and returning content whose
        // access was never checked.
        "src/connectors/acl-guard.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // Who the asking user is, in the source systems' terms. The ACL guard
        // probes with whatever this resolves, so a half-populated identity is
        // another user's view of the corpus.
        "src/identity/workos-resolver.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // Signature verification on the OAuth start URL: the check that stops a
        // leaked link being replayed or re-pointed at another user.
        "src/oauth/url-token.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // The audit ledger — emit, durable consume, and the PII scrub that runs
        // before either. An unrecorded or unscrubbed query is a compliance gap
        // that nothing downstream can reconstruct.
        "src/audit/audit-logger.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "src/audit/audit-consumer.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "src/audit/pii-scrubber.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
