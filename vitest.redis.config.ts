import { defineConfig } from "vitest/config";

// The live-Redis tier, on its own config so `npm test` can never pick it up.
// Separate directory, separate include, separate CI job — "tests passed" and
// "the Lua the limiter ships was run by a Redis" are two statements, and only
// one of them is true without a server.
//
// Unlike the model tier this runs on every pull request: a Redis container is
// free and deterministic, so the thing that made the limiter's atomicity
// unverifiable is a service block rather than a budget.
//
// No coverage block: this tier exists to run a script inside Redis, not to
// reach lines of this repo.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["integration/**/*.integration.ts"],
    setupFiles: ["src/test-setup.ts"],
    // A container that has just started may not be accepting connections yet.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One suite at a time: these share one Redis and assert on key state.
    fileParallelism: false,
  },
});
