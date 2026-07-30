#!/usr/bin/env node
/**
 * Validate `platform.yaml` against the real eks-agent-platform CRD schemas.
 *
 *   node scripts/validate-platform-manifests.mjs             # the gate
 *   node scripts/validate-platform-manifests.mjs --self-test # prove the gate rejects
 *   node scripts/validate-platform-manifests.mjs <path>      # validate a copy elsewhere
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
 * `schemas/crd/source.json` (see `scripts/sync-crd-schemas.mjs`). They are read
 * off disk and their digests verified before anything is validated: a missing,
 * unreadable, altered, or undeclared schema aborts the run. A gate that passes
 * because it could not find its schema is worse than no gate, and a gate that
 * validates against a schema someone widened by hand is worse still — it
 * reports a verdict about a schema the API server has never seen. The
 * undeclared case is the same hole from the other side: a `.yaml` in
 * `schemas/crd/` that `source.json` does not list has no recorded digest, so
 * nothing here can tell it from an edit. `--self-test` covers the tamper case
 * directly: it mutates a vendored schema in memory and fails unless the digest
 * check rejects it.
 *
 * Freshness of the vendored copies is the other half, and it lives in
 * `scripts/sync-crd-schemas.mjs --check`: CI compares them byte-for-byte
 * against nanohype/eks-agent-platform at the ref pinned in `source.json`.
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
 * Verify one vendored schema's bytes against its recorded digest.
 *
 * Pulled out of the loading loop so `--self-test` can hand it a deliberately
 * mutated buffer and assert the rejection, rather than the tamper check being
 * a branch nothing ever takes.
 *
 * @param {string} file  filename under schemas/crd/
 * @param {Buffer} raw   the bytes on disk
 * @param {string} expected  the sha256 recorded in source.json
 */
function verifyDigest(file, raw, expected) {
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== expected) {
    throw new GateError(
      `vendored CRD schema schemas/crd/${file} does not match its recorded digest ` +
        `(source.json records ${expected}, on disk ${actual}). The vendored schemas are ` +
        "byte-identical copies of the operator's controller-gen output — they are never " +
        "hand-edited. Restore them with `npm run schemas:sync`.",
    );
  }
}

/**
 * Read the vendored CRDs and verify them against the recorded digests.
 * Anything wrong here is fatal — the gate never runs on an unverified schema.
 *
 * @returns {Promise<{registry: Map<string, {kind: string, scope: string, schema: object}>,
 *   sample: {file: string, raw: Buffer, sha256: string}}>}
 *   `registry` is keyed by `<apiVersion>|<kind>`; `sample` is one verified
 *   schema the self-test tampers with.
 */
async function loadSchemas() {
  let source;
  try {
    source = JSON.parse(await readFile(join(SCHEMA_DIR, "source.json"), "utf8"));
  } catch (err) {
    throw new GateError(
      `cannot read schemas/crd/source.json (${err.message}). The CRD schemas are ` +
        "vendored into this repo; restore them with `npm run schemas:sync`.",
    );
  }
  if (!source.upstream?.repository || !/^[0-9a-f]{40}$/.test(source.upstream?.ref ?? "")) {
    throw new GateError(
      "schemas/crd/source.json needs `upstream.repository` and a full 40-character " +
        "`upstream.ref` — a branch name pins nothing, and the digests below describe " +
        "whatever commit that is.",
    );
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new GateError("schemas/crd/source.json declares no schema files");
  }

  // A schema on disk that source.json does not declare has no recorded digest,
  // so the loop below never hashes it and nothing here can tell it from an
  // edit. Left unchecked, dropping a hand-written CRD into schemas/crd/ is a
  // way to hand the walker a schema the gate never verified. Reject it.
  const declared = new Set(source.files.map((entry) => entry.file));
  let present;
  try {
    present = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".yaml"));
  } catch (err) {
    throw new GateError(
      `cannot read the vendored CRD schemas in schemas/crd (${err.message}). ` +
        "Restore them with `npm run schemas:sync`.",
    );
  }
  const stray = present.filter((f) => !declared.has(f)).sort();
  if (stray.length > 0) {
    throw new GateError(
      `schemas/crd/ holds YAML that source.json does not declare: ${stray.join(", ")}. ` +
        "An undeclared schema carries no recorded digest, so the gate cannot verify it — " +
        "record it with `npm run schemas:sync`, or delete it.",
    );
  }

  const registry = new Map();
  let sample = null;

  for (const entry of source.files) {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
      throw new GateError(
        `schemas/crd/source.json entry ${entry.file} carries no valid sha256 digest — the ` +
          "gate refuses to validate against a schema it cannot verify.",
      );
    }
    const path = join(SCHEMA_DIR, entry.file);
    let raw;
    try {
      raw = await readFile(path);
    } catch (err) {
      throw new GateError(
        `vendored CRD schema schemas/crd/${entry.file} is missing (${err.message}). ` +
          "Restore it with `npm run schemas:sync`.",
      );
    }
    verifyDigest(entry.file, raw, entry.sha256);
    sample ??= { file: entry.file, raw, sha256: entry.sha256 };

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

  return { registry, sample };
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
        "`npm run schemas:sync`.",
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

/**
 * Does an `allowedModels` entry grant an invoked model id?
 *
 * Exact match, or a bare foundation-model id granting its `us.` cross-region
 * profile — how the operator expands a bare entry. Deliberately not a prefix
 * test: `...-sonnet-4` must not satisfy `...-sonnet-5`.
 */
function modelGrantCovers(allowed, invoked) {
  if (allowed === invoked) return true;
  if (/^[a-z]{2,6}\./.test(allowed) && !allowed.startsWith("anthropic.")) return false;
  return invoked === `us.${allowed}`;
}

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

  // ── the model plane ───────────────────────────────────────────────────
  //
  // The gateway runs under the tenant ServiceAccount, so it invokes Bedrock as
  // the tenant and the operator's explicit Deny over NotResource applies to it.
  // A model a route names and allowedModels omits is AccessDenied on every call,
  // in a deployment whose CI is green — and both sides are free-form strings, so
  // nothing but this holds them together.
  //
  // What is checked is the model each route *invokes*: its crossRegionProfile
  // when set, otherwise its modelId — the same resolution the operator applies
  // when it fills modelNameOverride. Checking both would reject a CR that grants
  // only `us.`-prefixed models, which is correct: on such a route the bare id is
  // metadata and never reaches Bedrock.
  const gateways = docs.filter((d) => d.kind === "ModelGateway");
  const allowed = identity.allowedModels;
  if (
    Array.isArray(allowed) &&
    allowed.length > 0 &&
    !(identity.allowedModelFamilies?.length > 0)
  ) {
    for (const g of gateways) {
      for (const route of g.spec?.routes ?? []) {
        if (route.modelSource === "imported") continue;
        const field = route.crossRegionProfile ? "crossRegionProfile" : "modelId";
        const invoked = route.crossRegionProfile || route.modelId;
        if (typeof invoked !== "string" || invoked === "") continue;
        if (allowed.some((a) => modelGrantCovers(a, invoked))) continue;
        errors.push(
          `ModelGateway/${g.metadata?.name}: routes[${route.name}].${field}="${invoked}" is not ` +
            `covered by Platform.spec.identity.allowedModels [${allowed.join(", ")}] — the gateway ` +
            "invokes Bedrock as the tenant, and the operator denies every model outside that list",
        );
      }
    }
  }

  // The operator derives the endpoint from the Platform name and never reads the
  // chart; the chart names routes the CR must declare. A rename on either side
  // yields pods that start cleanly and fail every model call — connection
  // refused, or a gateway 404 for an unmatched route.
  const declaredRoutes = new Set(
    gateways.flatMap((g) => (g.spec?.routes ?? []).map((r) => r.name)),
  );
  const expectedEndpoint = `http://${platformName}-gateway.tenants-${platformName}.svc.cluster.local:8080`;
  for (const { file, values } of chartValues) {
    const endpoint = values?.env?.MODEL_GATEWAY_ENDPOINT;
    if (typeof endpoint === "string" && endpoint !== "" && endpoint !== expectedEndpoint) {
      errors.push(
        `${file}: env.MODEL_GATEWAY_ENDPOINT="${endpoint}" is not the endpoint the operator ` +
          `publishes for Platform/${platformName} ("${expectedEndpoint}") — the app starts ` +
          "cleanly and fails every model call with a connection error",
      );
    }
    for (const key of ["MODEL_ROUTE", "EMBEDDING_ROUTE"]) {
      const route = values?.env?.[key];
      if (typeof route !== "string" || route === "" || declaredRoutes.size === 0) continue;
      if (declaredRoutes.has(route)) continue;
      errors.push(
        `${file}: env.${key}="${route}" names no route on the ModelGateway (declared: ` +
          `${[...declaredRoutes].join(", ")}) — the gateway has no rule matching it, so every ` +
          "request is refused at the gateway rather than reaching a model",
      );
    }
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
 * Tamper with a verified schema in memory and assert the digest check rejects
 * it. Without this the integrity half of the gate is a branch nothing exercises
 * — and an unexercised rejection path is indistinguishable from no path at all.
 *
 * The mutation is the realistic one: widen an enum so a value the API server
 * would refuse starts validating clean. It stays valid YAML and parses to a
 * usable CRD, which is exactly why byte digests rather than schema
 * plausibility are what catch it.
 */
function schemaIntegritySelfTest(sample) {
  const widened = Buffer.from(
    sample.raw
      .toString("utf8")
      .replace(/^([ ]*)enum:\n\1(- .*)$/m, "$1enum:\n$1- tampered-by-self-test\n$1$2"),
  );
  if (widened.equals(sample.raw)) {
    return [`could not construct a tampered copy of schemas/crd/${sample.file}`];
  }
  try {
    verifyDigest(sample.file, widened, sample.sha256);
  } catch (err) {
    if (err instanceof GateError) {
      out(`  PASS  rejects: a vendored schema edited in place (schemas/crd/${sample.file})`);
      out(`          → ${err.message.split(". ")[0]}`);
      return [];
    }
    throw err;
  }
  out(`  FAIL  rejects: a vendored schema edited in place (schemas/crd/${sample.file})`);
  return [`a tampered copy of schemas/crd/${sample.file} passed the digest check`];
}

/**
 * Break a copy of the real manifest four ways and assert each is rejected,
 * tamper with a vendored schema and assert that is rejected too, then assert
 * the untouched manifest passes. Runs in memory — nothing is written — so the
 * gate's own rejection behaviour is CI-enforced rather than asserted once by
 * hand.
 */
function selfTest(documents, registry, chartValues, sample) {
  const clone = () => JSON.parse(JSON.stringify(documents));
  const cases = [
    {
      // The drift that costs: a route's model moves and allowedModels does not,
      // so the operator's Deny makes every call AccessDenied while CI stays green.
      name: "a route model that allowedModels does not grant",
      mutate: (docs) => {
        docs.find((d) => d.kind === "Platform").spec.identity.allowedModels = [
          "us.anthropic.claude-opus-5",
        ];
      },
      expect: /is not covered by Platform\.spec\.identity\.allowedModels/,
    },
    {
      // The chart names routes; the CR declares them. Nothing else couples the
      // two, and a mismatch is a gateway 404 on every request.
      name: "a route renamed on the CR while the chart still names the old one",
      mutate: (docs) => {
        docs.find((d) => d.kind === "ModelGateway").spec.routes[1].name = "vectors";
      },
      expect: /names no route on the ModelGateway/,
    },
    {
      // The operator derives the endpoint from the Platform name and never reads
      // the chart, so a rename on either side is connection-refused at run time.
      name: "a Platform renamed so the published endpoint no longer matches the chart",
      mutate: (docs) => {
        docs.find((d) => d.kind === "Platform").metadata.name = "slack-knowledge-bot-v2";
      },
      expect: /is not the endpoint the operator publishes/,
    },
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

  failures.push(...schemaIntegritySelfTest(sample));

  const clean = validate(clone(), registry, chartValues);
  out(`  ${clean.length === 0 ? "PASS" : "FAIL"}  accepts: the committed platform.yaml`);
  if (clean.length > 0) failures.push(`committed platform.yaml rejected: ${clean.join("; ")}`);

  return failures;
}

async function main() {
  const { registry, sample } = await loadSchemas();
  const documents = loadAll(await readFile(MANIFEST_PATH, "utf8")).filter(Boolean);
  if (documents.length === 0) throw new GateError(`${MANIFEST_PATH} contains no documents`);
  const chartValues = await loadChartValues();

  if (process.argv.includes("--self-test")) {
    out("platform.yaml gate — self-test");
    const failures = selfTest(documents, registry, chartValues, sample);
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
