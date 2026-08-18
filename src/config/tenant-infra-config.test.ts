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

describe("AWS_REGION is required, not defaulted", () => {
  const fields = schemaFields();

  /**
   * The region is not a tenantInfra slot — it arrives from `.Values.env` — so
   * the suite above does not cover it. It still belongs in the same tier: it
   * is what resolves every table name, queue URL and key ARN the schema
   * requires, so a default does not fill a blank, it guesses which partition
   * to reach into. A wrong guess surfaces as an opaque AccessDenied on a
   * request path (or, under a region-lock SCP, on every path) instead of at
   * boot, which is the failure this repo already hit once.
   *
   * Asserted against the declaration text rather than by parsing the schema,
   * because `loadConfig()` calls `process.exit(1)` at module load — the same
   * technique the suite above uses, and it fails the day someone re-adds a
   * default.
   */
  it("declares AWS_REGION with no default", () => {
    const decl = fields.get("AWS_REGION");
    expect(decl, "AWS_REGION missing from the config schema entirely").toBeDefined();
    expect(
      decl?.includes(".default("),
      `AWS_REGION must stay required — found: ${decl}`,
    ).toBe(false);
    expect(
      decl?.includes(".min("),
      `AWS_REGION must reject the empty string — found: ${decl}`,
    ).toBe(true);
  });

  it("is supplied to both deployments so requiring it cannot brick a rollout", () => {
    // Requiring a value the chart does not ship would trade a silent wrong
    // region for a crash-looping pod. The two Deployments get it by different
    // routes, so each is checked at its own source.
    //
    // The app Deployment renders `range $k, $v := .Values.env`, so the key
    // must exist in values.yaml — the template never names it.
    const values = readFileSync(join(ROOT, "chart", "values.yaml"), "utf8");
    expect(values, "values.yaml env block does not set AWS_REGION").toMatch(
      /^\s{2}AWS_REGION:\s*\S+/m,
    );

    // The audit-consumer Deployment enumerates its env explicitly.
    const consumer = readFileSync(
      join(ROOT, "chart", "templates", "audit-consumer-deployment.yaml"),
      "utf8",
    );
    expect(consumer, "audit-consumer-deployment.yaml does not wire AWS_REGION").toMatch(
      /- name:\s*AWS_REGION/,
    );
  });
});

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
