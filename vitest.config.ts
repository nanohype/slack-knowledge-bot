import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // bootstrap; only verifiable in real-Slack integration
        "src/connectors/types.ts", // type declarations only
        "src/scripts/**", // one-off dev seeders; run via ecs execute-command, not in-app
        "src/rag/backends/pgvector-schema.ts", // DDL bootstrap; exercised by RDS at deploy time
        "src/oauth/router.ts", // OAuth wiring; exercised by the real provider handshake (integration only)
        "src/oauth/http.ts", // node:http ↔ Web Request bridge; covered end-to-end by smoke test
        "src/test-setup.ts",
        "src/**/*.test.ts",
      ],
      thresholds: {
        branches: 60,
        functions: 75,
        lines: 75,
        statements: 75,
      },
    },
  },
});
