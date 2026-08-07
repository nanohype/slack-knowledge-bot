import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every env var wired from a `tenantInfra` slot must reject the empty string.
 *
 * Those slots ship empty on purpose — `values-development.yaml` says so in a
 * comment: "Fill the empties below from the landing-zone tenant-substrate
 * development outputs". An unfilled slot therefore reaches the pod as `""`, and
 * the whole question is whether that fails at boot or somewhere later.
 *
 * `KMS_KEY_ID` already carried `.min(1)` with the reason written above it: a
 * bare `z.string()` accepts an empty value, "the pod starts, then fails on the
 * first envelope operation instead of at boot." `REDIS_URL` was declared on the
 * line immediately below that comment and did not carry it. The consequence is
 * worse than the one the comment describes, because it never fails at all:
 * `new Redis("")` with `lazyConnect: false` connects to ioredis's localhost
 * default, so the pod boots, reports healthy, logs a connection error on a loop,
 * and every rate-limit check silently misses against a cache that is provisioned
 * and billed.
 *
 * This reads the chart and the schema rather than restating either, so a new
 * tenantInfra slot is covered the day it is wired.
 */
const ROOT = process.cwd();
const DEPLOYMENT = join(ROOT, "chart", "templates", "deployment.yaml");
const SCHEMA = join(ROOT, "src", "config", "index.ts");

/** env var name -> tenantInfra slot, read off the chart's own wiring. */
function tenantInfraEnvVars(): Map<string, string> {
  const tpl = readFileSync(DEPLOYMENT, "utf8");
  const out = new Map<string, string>();
  const re =
    /- name:\s*([A-Z][A-Z0-9_]*)\s*\n\s*value:\s*\{\{\s*\.Values\.tenantInfra\.([A-Za-z0-9_]+)/g;
  for (const m of tpl.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Fields the zod schema declares, with the text of their declaration. */
function schemaFields(): Map<string, string> {
  const src = readFileSync(SCHEMA, "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(z\.[^\n]+?),?\s*$/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

describe("tenantInfra-wired config", () => {
  const wired = tenantInfraEnvVars();
  const fields = schemaFields();

  it("finds the chart's tenantInfra wiring at all", () => {
    // A regex that matches nothing passes every assertion below, which is how
    // this check would stop checking.
    expect(wired.size).toBeGreaterThan(5);
    expect(fields.size).toBeGreaterThan(10);
  });

  it("rejects an empty value for every slot the chart ships empty", () => {
    const offenders: string[] = [];
    for (const [envVar, slot] of wired) {
      const decl = fields.get(envVar);
      // A slot the schema does not validate is out of scope here; a slot it
      // validates as a bare string is the defect.
      if (decl === undefined) continue;
      const bounded =
        decl.includes(".min(") || decl.includes(".url(") || decl.includes(".default(");
      if (!bounded) offenders.push(`${envVar} (tenantInfra.${slot}): ${decl}`);
    }

    expect(
      offenders,
      "these env vars are wired from tenantInfra slots that ship empty, and accept an empty " +
        "value. An unfilled slot must fail at boot, not resolve to a default the operator " +
        "never chose:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("keeps REDIS_URL bounded specifically", () => {
    // The instance that motivated this file, pinned by name so a refactor of
    // the generic assertion above cannot quietly drop it.
    expect(fields.get("REDIS_URL")).toContain(".min(1)");
  });
});
