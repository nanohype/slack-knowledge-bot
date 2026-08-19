#!/usr/bin/env node
/**
 * Boot smoke test for the audit-consumer entrypoint.
 *
 * The defect this exists for: `src/bin/audit-consumer.ts` transitively imported
 * the app config, which calls `process.exit(1)` at module scope, so the pod died
 * at import time on ~25 values its Deployment does not supply. Nothing caught it
 * — the file is coverage-excluded, and it had never been deployed.
 *
 * `src/logger.import-graph.test.ts` guards that specific mechanism (config
 * reachability) and is the durable half. It cannot catch a different mechanism
 * producing the same outcome: a chart env var dropped, a new module-scope side
 * effect, a changed entrypoint. All boot failures, none visible to an
 * import-graph assertion. This runs the binary instead.
 *
 * Env is read from the RENDERED chart rather than hand-copied, so the job and
 * `chart/templates/audit-consumer-deployment.yaml` cannot drift apart — a
 * hand-copied list is precisely the drift this is meant to catch. Names come
 * from the manifest; the tenantInfra slots ship empty by design, so those get
 * obvious placeholders. If the chart stops supplying something the binary
 * requires, the binary exits 1 and this fails.
 *
 * Hermetic: no AWS credentials. The consumer reaches SQS, fails with
 * CredentialsProviderError and backs off — correct off-cluster behaviour — while
 * still serving /health. The assertion stops at ready, before any of that
 * matters. AWS_* credential vars are stripped so a runner that happens to have
 * them cannot make this pass for the wrong reason.
 *
 * Usage: node scripts/smoke-audit-consumer.mjs [rendered-manifest.yaml]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadAll } from "js-yaml";

const MANIFEST = process.argv[2] ?? "rendered/staging.yaml";
const PORT = 3097;
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

function fail(msg, extra) {
  console.error(`SMOKE FAIL: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

/** The audit-consumer container out of the rendered chart. */
function auditConsumerContainer() {
  const docs = loadAll(readFileSync(MANIFEST, "utf8")).filter(Boolean);
  const deploys = docs.filter((d) => d?.kind === "Deployment");
  if (deploys.length === 0) fail(`no Deployment in ${MANIFEST}`);

  for (const d of deploys) {
    for (const c of d.spec?.template?.spec?.containers ?? []) {
      const cmd = [...(c.command ?? []), ...(c.args ?? [])].join(" ");
      if (cmd.includes("audit-consumer")) return c;
    }
  }
  fail(
    `no container running dist/bin/audit-consumer.js in ${MANIFEST} — ` +
      `either the Deployment was removed or its command changed`,
  );
}

const container = auditConsumerContainer();
const declared = container.env ?? [];
if (declared.length === 0) fail("the audit-consumer container declares no env at all");

// Names come from the chart. Values too, except the tenantInfra slots that ship
// empty on purpose — those get a placeholder so the binary has something
// non-empty to validate, which is what its required-env check demands.
const PLACEHOLDERS = {
  SQS_AUDIT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/000000000000/smoke-audit.fifo",
  DYNAMODB_TABLE_AUDIT: "smoke-audit-table",
  AUDIT_BUCKET: "smoke-audit-bucket",
};

const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT) };
const filled = [];
for (const { name, value } of declared) {
  if (typeof name !== "string") continue;
  const resolved = value !== undefined && value !== "" ? value : PLACEHOLDERS[name];
  if (resolved === undefined) {
    fail(
      `chart declares ${name} with an empty value and this script has no placeholder for it. ` +
        `Add one to PLACEHOLDERS — the point of deriving env from the chart is that a new ` +
        `slot shows up here rather than being silently skipped.`,
    );
  }
  env[name] = resolved;
  filled.push(name);
}
console.error(`env from ${MANIFEST}: ${filled.join(", ")}`);

const child = spawn("node", ["dist/bin/audit-consumer.js"], {
  env, // deliberately not {...process.env} — no AWS creds, no ambient config
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (c) => (output += c));
child.stderr.on("data", (c) => (output += c));

let exitedEarly = null;
child.on("exit", (code, signal) => {
  if (exitedEarly === null) exitedEarly = { code, signal };
});

const deadline = Date.now() + READY_TIMEOUT_MS;
let ready = false;
while (Date.now() < deadline) {
  if (exitedEarly) {
    fail(
      `the binary exited before becoming ready (code=${exitedEarly.code} signal=${exitedEarly.signal}). ` +
        `This is the boot failure the test exists to catch.`,
      output,
    );
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.status === 200) {
      ready = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

child.kill("SIGTERM");

if (!ready) {
  fail(`/health did not answer 200 within ${READY_TIMEOUT_MS}ms`, output);
}
if (!output.includes("audit-consumer: started")) {
  fail("/health answered but the consumer never logged that it started", output);
}

console.error("SMOKE PASS: audit-consumer booted under its chart env and served /health 200");
process.exit(0);
