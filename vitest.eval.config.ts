import { defineConfig } from "vitest/config";

// The model tier runs on its own config so it can never be picked up by
// `npm test`. Separate file, separate include, separate CI job — the whole
// design goal is that "tests passed" and "evals passed" are two statements
// nobody can confuse for one.
//
// No coverage block: an eval measures a model, not lines of this repo.
export default defineConfig({
  test: {
    // MODEL_GATEWAY_ENDPOINT has no default in config, by design: the operator
    // derives it from the Platform name, so there is no sensible one to guess.
    // Supplied here so every suite that loads the config can start.
    env: {
      MODEL_GATEWAY_ENDPOINT: "http://gw.tenants-x.svc.cluster.local:8080",
    },
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    // Generator imports logger → config, which Zod-parses process.env at
    // module load. Same placeholder defaults the unit suite uses — the
    // model tier never talks to Slack/DDB/Redis, only Bedrock.
    setupFiles: ["src/test-setup.ts"],
    // Real model calls, several per case. The per-case bound lives in the
    // suite's beforeAll; this is the outer backstop.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One suite at a time. Concurrency within a suite is bounded on purpose
    // (see rag.eval.ts) and file-level parallelism would multiply it
    // straight into a provider rate limit.
    fileParallelism: false,
  },
});
