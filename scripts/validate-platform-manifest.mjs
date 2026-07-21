#!/usr/bin/env node
/**
 * Validate `platform.yaml` against the real eks-agent-platform CRD schemas.
 *
 *   node scripts/validate-platform-manifest.mjs             # the gate
 *   node scripts/validate-platform-manifest.mjs --self-test # prove the gate rejects
 *   node scripts/validate-platform-manifest.mjs <path>      # validate a copy elsewhere
 *
 * `platform.yaml` is applied by hand, once, before ArgoCD takes over. Nothing
 * else in this repo reads it, so a field typo, a missing required key, or a
 * `spec.tenant` pointing at a Tenant that isn't there survives every other
 * gate and only surfaces as a rejected `kubectl apply` — or worse, as a
 * Platform that reconciles into the wrong tenant boundary.
 *
 * Three classes of check run here:
 *
 *   1. Schema. Every document is walked against the openAPIV3Schema of its
 *      CRD: required properties, types, enums, patterns, bounds — and unknown
 *      properties. That last one is the reason this is a hand-written walker
 *      rather than a stock JSON-Schema validator: controller-gen does not emit
 *      `additionalProperties: false`, so a stock validator happily accepts an
 *      invented field. Kubernetes prunes those fields at apply time, silently.
 *      Here they are errors.
 *
 *   2. Scope. `Tenant` is cluster-scoped and must carry no
 *      `metadata.namespace`; `Platform` and `BudgetPolicy` are namespaced and
 *      must. Scope comes from the CRD's own `spec.scope`, not from a list kept
 *      here.
 *
 *   3. Consistency. The references that tie the three documents together and
 *      tie them to the chart: `Platform.spec.tenant` must name a Tenant
 *      declared in this file, `Platform.spec.budget.name` must name a
 *      BudgetPolicy in the same namespace, that BudgetPolicy must point back,
 *      and the OTel `agents.tenant` / `agents.platform` resource attributes in
 *      every `chart/values*.yaml` must agree with both.
 *
 * The schemas are vendored under `schemas/crd/` with SHA-256 digests in
 * `schemas/crd/provenance.json` (see `scripts/sync-crd-schemas.mjs`). They are
 * read off disk and their digests verified before anything is validated: a
 * missing, unreadable, or altered schema aborts the run. A gate that passes
 * because it could not find its schema is worse than no gate.
 *
 * Not evaluated: CEL `x-kubernetes-validations`. The one rule that constrains
 * this manifest — allowedModels and allowedModelFamilies are mutually
 * exclusive — is asserted explicitly in the consistency pass instead.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const SCHEMA_DIR = join(ROOT, "schemas", "crd");
const CHART_DIR = join(ROOT, "chart");

// Optional positional path so a copy can be validated from anywhere — how the
// gate's rejection behaviour is demonstrated without ever committing a broken
// manifest. Defaults to this repo's own platform.yaml.
const MANIFEST_PATH =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? join(ROOT, "platform.yaml");
const MANIFEST_LABEL = MANIFEST_PATH.split("/").pop();

const out = (line) => process.stdout.write(`${line}\n`);

class GateError extends Error {}

// ── schema loading ──────────────────────────────────────────────────────────

/**
 * Read the vendored CRDs and verify them against the recorded digests.
 * Anything wrong here is fatal — the gate never runs on an unverified schema.
 *
 * @returns {Promise<Map<string, {kind: string, scope: string, schema: object}>>}
 *   keyed by `<apiVersion>|<kind>`.
 */
async function loadSchemas() {
  let provenance;
  try {
    provenance = JSON.parse(await readFile(join(SCHEMA_DIR, "provenance.json"), "utf8"));
  } catch (err) {
    throw new GateError(
      `cannot read schemas/crd/provenance.json (${err.message}). The CRD schemas are ` +
        "vendored into this repo; restore them with `npm run sync:crd-schemas`.",
    );
  }
  if (!Array.isArray(provenance.files) || provenance.files.length === 0) {
    throw new GateError("schemas/crd/provenance.json declares no schema files");
  }

  const registry = new Map();

  for (const entry of provenance.files) {
    const path = join(SCHEMA_DIR, entry.file);
    let raw;
    try {
      raw = await readFile(path);
    } catch (err) {
      throw new GateError(
        `vendored CRD schema schemas/crd/${entry.file} is missing (${err.message}). ` +
          "Restore it with `npm run sync:crd-schemas`.",
      );
    }
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== entry.sha256) {
      throw new GateError(
        `vendored CRD schema schemas/crd/${entry.file} does not match its recorded digest ` +
          `(expected ${entry.sha256}, got ${actual}). Re-vendor with ` +
          "`npm run sync:crd-schemas` so the pinned commit and the digests agree.",
      );
    }

    const crd = loadAll(raw.toString("utf8")).filter(Boolean)[0];
    if (crd?.kind !== "CustomResourceDefinition") {
      throw new GateError(`schemas/crd/${entry.file} is not a CustomResourceDefinition`);
    }
    const { group, names, scope, versions } = crd.spec;
    for (const version of versions) {
      const schema = version.schema?.openAPIV3Schema;
      if (!schema) {
        throw new GateError(
          `schemas/crd/${entry.file} version ${version.name} carries no openAPIV3Schema`,
        );
      }
      registry.set(`${group}/${version.name}|${names.kind}`, {
        kind: names.kind,
        scope,
        schema,
      });
    }
  }

  return registry;
}

// ── strict schema walker ────────────────────────────────────────────────────

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};

const typeMatches = (expected, actual) =>
  expected === actual || (expected === "number" && actual === "integer");

/**
 * Walk `value` against an OpenAPI v3 schema node, pushing human-readable
 * problems onto `errors`. Unknown object properties are errors unless the node
 * declares no `properties` at all (an opaque object, e.g. `metadata`) or opts
 * into free-form content via `additionalProperties` / `x-kubernetes-preserve-unknown-fields`.
 */
function walk(value, schema, path, errors) {
  if (schema.type && !typeMatches(schema.type, typeOf(value))) {
    errors.push(`${path}: expected type ${schema.type}, got ${typeOf(value)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: has ${value.length} items, minItems is ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        walk(item, schema.items, `${path}[${i}]`, errors);
      });
    }
    return;
  }

  if (value === null || typeof value !== "object") return;

  const properties = schema.properties;
  const freeForm =
    schema.additionalProperties !== undefined ||
    schema["x-kubernetes-preserve-unknown-fields"] === true ||
    properties === undefined;

  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const childSchema = properties?.[key];
    if (!childSchema) {
      if (!freeForm) {
        errors.push(
          `${childPath}: unknown property — not defined by the CRD schema ` +
            "(Kubernetes would prune it silently)",
        );
      }
      continue;
    }
    walk(child, childSchema, childPath, errors);
  }
}

// ── document-level checks ───────────────────────────────────────────────────

function validateDocument(doc, index, registry, errors) {
  const at = `${MANIFEST_LABEL}[${index}]`;

  if (!doc || typeof doc !== "object") {
    errors.push(`${at}: not a mapping`);
    return null;
  }
  for (const key of ["apiVersion", "kind", "metadata"]) {
    if (!doc[key]) {
      errors.push(`${at}: missing ${key}`);
      return null;
    }
  }

  const name = doc.metadata?.name;
  if (!name) {
    errors.push(`${at}: missing metadata.name`);
    return null;
  }

  const label = `${doc.kind}/${name}`;
  const entry = registry.get(`${doc.apiVersion}|${doc.kind}`);
  if (!entry) {
    errors.push(
      `${at} (${label}): no vendored CRD schema for ${doc.apiVersion} ${doc.kind}. ` +
        "Either the apiVersion/kind is wrong, or the schema needs vendoring via " +
        "`npm run sync:crd-schemas`.",
    );
    return null;
  }

  const namespace = doc.metadata?.namespace;
  if (entry.scope === "Cluster" && namespace) {
    errors.push(
      `${label}: ${doc.kind} is cluster-scoped but sets metadata.namespace="${namespace}"`,
    );
  }
  if (entry.scope === "Namespaced" && !namespace) {
    errors.push(`${label}: ${doc.kind} is namespaced but sets no metadata.namespace`);
  }

  walk(doc, entry.schema, label, errors);
  return doc;
}

// ── consistency across documents and the chart ──────────────────────────────

/** Parse an `OTEL_RESOURCE_ATTRIBUTES` string into a plain object. */
const parseResourceAttributes = (value) =>
  Object.fromEntries(
    String(value)
      .split(",")
      .map((pair) => pair.split("="))
      .filter((parts) => parts.length === 2)
      .map(([k, v]) => [k.trim(), v.trim()]),
  );

function checkConsistency(docs, chartValues, errors) {
  const byKind = (kind) => docs.filter((d) => d?.kind === kind);
  const tenants = byKind("Tenant");
  const platforms = byKind("Platform");
  const budgets = byKind("BudgetPolicy");

  if (tenants.length !== 1) {
    errors.push(
      `${MANIFEST_LABEL} declares ${tenants.length} Tenant documents, expected exactly 1`,
    );
  }
  if (platforms.length !== 1) {
    errors.push(
      `${MANIFEST_LABEL} declares ${platforms.length} Platform documents, expected exactly 1`,
    );
  }
  if (tenants.length !== 1 || platforms.length !== 1) return;

  const tenant = tenants[0];
  const platform = platforms[0];
  const tenantName = tenant.metadata.name;
  const platformName = platform.metadata.name;

  if (platform.spec?.tenant !== tenantName) {
    errors.push(
      `Platform/${platformName}: spec.tenant="${platform.spec?.tenant}" does not match the ` +
        `declared Tenant "${tenantName}" — the Platform would reconcile against a Tenant ` +
        "that does not exist on the cluster",
    );
  }

  const budgetName = platform.spec?.budget?.name;
  const budget = budgets.find(
    (b) => b.metadata.name === budgetName && b.metadata.namespace === platform.metadata.namespace,
  );
  if (!budget) {
    errors.push(
      `Platform/${platformName}: spec.budget.name="${budgetName}" has no BudgetPolicy of that ` +
        `name in namespace "${platform.metadata.namespace}"`,
    );
  } else if (budget.spec?.platformRef?.name !== platformName) {
    errors.push(
      `BudgetPolicy/${budget.metadata.name}: spec.platformRef.name=` +
        `"${budget.spec?.platformRef?.name}" does not point back at Platform/${platformName}`,
    );
  }

  const identity = platform.spec?.identity ?? {};
  if (identity.allowedModels?.length > 0 && identity.allowedModelFamilies?.length > 0) {
    errors.push(
      `Platform/${platformName}: spec.identity.allowedModels and allowedModelFamilies are ` +
        "mutually exclusive (CRD admission rule)",
    );
  }

  for (const { file, values } of chartValues) {
    const attributes = values?.env?.OTEL_RESOURCE_ATTRIBUTES;
    if (attributes) {
      const parsed = parseResourceAttributes(attributes);
      if (parsed["agents.tenant"] !== tenantName) {
        errors.push(
          `${file}: env.OTEL_RESOURCE_ATTRIBUTES agents.tenant=` +
            `"${parsed["agents.tenant"]}" does not match Tenant "${tenantName}"`,
        );
      }
      if (parsed["agents.platform"] !== platformName) {
        errors.push(
          `${file}: env.OTEL_RESOURCE_ATTRIBUTES agents.platform=` +
            `"${parsed["agents.platform"]}" does not match Platform "${platformName}"`,
        );
      }
    }

    const labelAttributes = values?.otel?.resourceAttributes;
    if (labelAttributes) {
      if (labelAttributes["agents.tenant"] !== tenantName) {
        errors.push(
          `${file}: otel.resourceAttributes["agents.tenant"]=` +
            `"${labelAttributes["agents.tenant"]}" does not match Tenant "${tenantName}"`,
        );
      }
      if (labelAttributes["agents.platform"] !== platformName) {
        errors.push(
          `${file}: otel.resourceAttributes["agents.platform"]=` +
            `"${labelAttributes["agents.platform"]}" does not match Platform "${platformName}"`,
        );
      }
    }
  }
}

// ── driver ──────────────────────────────────────────────────────────────────

/** @returns {string[]} every problem found, empty when the manifest is valid. */
function validate(documents, registry, chartValues) {
  const errors = [];
  const docs = documents.map((doc, i) => validateDocument(doc, i, registry, errors));
  checkConsistency(docs, chartValues, errors);
  return errors;
}

async function loadChartValues() {
  const files = (await readdir(CHART_DIR)).filter(
    (f) => f === "values.yaml" || /^values-.+\.yaml$/.test(f),
  );
  if (files.length === 0) throw new GateError(`no values files found under ${CHART_DIR}`);
  return Promise.all(
    files.sort().map(async (file) => ({
      file: `chart/${file}`,
      values: loadAll(await readFile(join(CHART_DIR, file), "utf8")).filter(Boolean)[0],
    })),
  );
}

const report = (errors) => {
  process.stderr.write(
    `${MANIFEST_LABEL} is invalid — ${errors.length} problem(s):\n` +
      `${errors.map((e) => `  ✗ ${e}`).join("\n")}\n`,
  );
};

/**
 * Break a copy of the real manifest three ways and assert each is rejected,
 * then assert the untouched manifest passes. Runs in memory — nothing is
 * written — so the gate's own rejection behaviour is CI-enforced rather than
 * asserted once by hand.
 */
function selfTest(documents, registry, chartValues) {
  const clone = () => JSON.parse(JSON.stringify(documents));
  const cases = [
    {
      name: "unknown field on Tenant.spec",
      mutate: (docs) => {
        docs.find((d) => d.kind === "Tenant").spec.aggregateMonthlyBudget = "5000";
      },
      expect: /unknown property/,
    },
    {
      name: "required field removed from Platform.spec",
      mutate: (docs) => {
        delete docs.find((d) => d.kind === "Platform").spec.budget;
      },
      expect: /missing required property "budget"/,
    },
    {
      name: "Platform.spec.tenant naming a Tenant that is not declared",
      mutate: (docs) => {
        docs.find((d) => d.kind === "Platform").spec.tenant = "marketing";
      },
      expect: /does not match the declared Tenant/,
    },
    {
      name: "namespace set on the cluster-scoped Tenant",
      mutate: (docs) => {
        docs.find((d) => d.kind === "Tenant").metadata.namespace = "tenants-workplace";
      },
      expect: /cluster-scoped but sets metadata\.namespace/,
    },
  ];

  const failures = [];
  for (const { name, mutate, expect } of cases) {
    const docs = clone();
    mutate(docs);
    const errors = validate(docs, registry, chartValues);
    const matched = errors.some((e) => expect.test(e));
    out(`  ${matched ? "PASS" : "FAIL"}  rejects: ${name}`);
    if (matched) {
      out(`          → ${errors.find((e) => expect.test(e))}`);
    } else {
      failures.push(`${name} (gate reported: ${errors.join("; ") || "no errors"})`);
    }
  }

  const clean = validate(clone(), registry, chartValues);
  out(`  ${clean.length === 0 ? "PASS" : "FAIL"}  accepts: the committed platform.yaml`);
  if (clean.length > 0) failures.push(`committed platform.yaml rejected: ${clean.join("; ")}`);

  return failures;
}

async function main() {
  const registry = await loadSchemas();
  const documents = loadAll(await readFile(MANIFEST_PATH, "utf8")).filter(Boolean);
  if (documents.length === 0) throw new GateError(`${MANIFEST_PATH} contains no documents`);
  const chartValues = await loadChartValues();

  if (process.argv.includes("--self-test")) {
    out("platform.yaml gate — self-test");
    const failures = selfTest(documents, registry, chartValues);
    if (failures.length > 0) {
      process.stderr.write(
        `gate self-test failed:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`,
      );
      process.exit(1);
    }
    out("gate self-test passed");
    return;
  }

  const errors = validate(documents, registry, chartValues);
  if (errors.length > 0) {
    report(errors);
    process.exit(1);
  }

  const kinds = documents.map((d) => `${d.kind}/${d.metadata?.name}`).join(", ");
  out(`${MANIFEST_LABEL} is valid against ${registry.size} vendored CRD schemas: ${kinds}`);
}

main().catch((err) => {
  process.stderr.write(
    err instanceof GateError
      ? `platform.yaml gate cannot run: ${err.message}\n`
      : `platform.yaml gate failed: ${err.stack ?? err.message}\n`,
  );
  process.exit(1);
});
