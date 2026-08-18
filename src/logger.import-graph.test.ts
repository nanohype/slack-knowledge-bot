import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `src/bin/audit-consumer.ts` must not reach the app config.
 *
 * The consumer is a second entrypoint. Its Deployment
 * (`chart/templates/audit-consumer-deployment.yaml`) ships ten env vars and
 * mounts no secret, because draining the audit queue needs a region, a queue
 * URL, a table and a bucket — not Slack tokens or OAuth client secrets.
 *
 * `src/config/index.ts` validates the *app's* ~25 required values and calls
 * `process.exit(1)` at module scope when the parse fails. Any import path from
 * the consumer to that module therefore kills the pod at import time, before
 * its own required-env check runs. It reached it through `logger.ts`, which
 * every module imports and which needed the config for exactly one field.
 *
 * The failure is quiet in the worst way: KEDA scales this Deployment 0..5 on
 * queue depth, so a pod that never becomes ready looks identical to "no
 * messages to drain" until the ledger has silently stopped draining.
 *
 * Asserted on the import graph rather than by booting the binary, so it fails
 * in a unit run on the day someone adds the import back — including
 * indirectly, through a module that only later grows a config dependency.
 */

const SRC = resolve(__dirname);
const ENTRY = join(SRC, "bin", "audit-consumer.ts");
const FORBIDDEN = join(SRC, "config", "index.ts");

/** Resolve a relative ESM specifier (`./x.js`) to the .ts file on disk. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every first-party module reachable from `entry`, with the path that got there. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const trail = seen.get(file) as string[];
    const text = readFileSync(file, "utf8");
    // Covers `import x from "..."`, `import "..."` and `export ... from "..."`.
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?['"]([^'"]+)['"]/g)) {
      const next = resolveSpecifier(file, m[1]);
      if (next === null || seen.has(next)) continue;
      seen.set(next, [...trail, next]);
      queue.push(next);
    }
  }
  return seen;
}

describe("audit-consumer import graph", () => {
  const reachable = reachableFrom(ENTRY);

  it("walks a real graph", () => {
    // A resolver that silently returns null for everything would make the
    // assertion below vacuous, which is how this check would stop checking.
    expect(reachable.size).toBeGreaterThan(3);
    expect([...reachable.keys()]).toContain(join(SRC, "logger.ts"));
  });

  it("never reaches the app config", () => {
    const trail = reachable.get(FORBIDDEN);
    const rel = (p: string) => relative(SRC, p);
    expect(
      trail === undefined,
      trail === undefined
        ? ""
        : `audit-consumer reaches the app config, which exits 1 at module scope on a ` +
            `failed parse — the consumer's Deployment mounts no secret, so this crash-loops ` +
            `the pod that drains the audit queue.\n  ${trail.map(rel).join("\n  → ")}`,
    ).toBe(true);
  });
});
