import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { createGenerator } from "../src/rag/generator.js";
import { type GradeResult, grade, loadSuite, score, toHits } from "./harness.js";

// The model tier. Real Bedrock, real prompts, real money.
//
// EVAL_LLM decides whether it runs, and the two states are deliberately
// asymmetric:
//
//   unset — skipped. Local default; running unit tests should not bill anyone.
//   set   — must run. A broken provider is a hard failure, never a skip, so a
//           green eval check always means the evals executed. Same contract as
//           the sibling suites in competitive-intelligence and digest-pipeline.

const suite = loadSuite("rag.json");
const configured = (process.env.EVAL_LLM ?? "").trim();

const MODEL_ID =
  process.env.EVAL_MODEL || process.env.BEDROCK_LLM_MODEL_ID || "us.anthropic.claude-sonnet-4-6";
const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";
// Match production default so stale cases exercise the real threshold.
const STALE_THRESHOLD_DAYS = Number(process.env.STALE_DOC_THRESHOLD_DAYS ?? 90);

describe.skipIf(configured === "")(`eval: ${suite.name}`, () => {
  const results = new Map<string, GradeResult>();

  beforeAll(async () => {
    if (configured !== "bedrock") {
      throw new Error(
        `EVAL_LLM="${configured}" is not supported here — this generator speaks ` +
          `Bedrock InvokeModel directly. Use EVAL_LLM=bedrock, or unset it to skip ` +
          `the model tier.`,
      );
    }

    const generator = createGenerator({
      bedrock: new BedrockRuntimeClient({ region: REGION }),
      llmModelId: MODEL_ID,
      staleThresholdDays: STALE_THRESHOLD_DAYS,
    });

    // Cases are independent, so run them concurrently — but bounded, because
    // a golden set that grows would otherwise open too many simultaneous
    // model calls and trip provider rate limits, which reads as an eval
    // failure rather than what it is.
    const queue = [...suite.cases];
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        try {
          const result = await generator.generate(
            c.input.question,
            toHits(c.input),
            c.input.hasRedactedHits,
          );
          results.set(c.id, grade(c.expect, result));
        } catch (err) {
          // A thrown case is a failed case, recorded as such. Leaving it
          // absent would let an outage read as a smaller suite that passed.
          results.set(c.id, {
            passed: false,
            failures: [
              {
                check: "mentions",
                detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          });
        }
      }
    });
    await Promise.all(workers);
  }, 300_000);

  // Adversarial cases are asserted one by one. There is no rate here: a
  // boundary that holds four times in five is not a boundary, and naming the
  // specific case that broke is the whole value when one does.
  for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
    it(`holds the line: ${c.id}`, () => {
      const r = results.get(c.id);
      expect(r, `${c.id} produced no result`).toBeDefined();
      const why = (r?.failures ?? []).map((f) => `${f.check}: ${f.detail}`).join("; ");
      expect(`${c.id} — ${why}`, `\n${c.rationale}\n`).toBe(`${c.id} — `);
    });
  }

  it("meets the capability floor", () => {
    const s = score(suite.cases, results);
    const failed = suite.cases
      .filter((c) => c.kind === "capability" && !results.get(c.id)?.passed)
      .map((c) => {
        const why = (results.get(c.id)?.failures ?? [])
          .map((f) => `${f.check}: ${f.detail}`)
          .join("; ");
        return `  ${c.id} — ${why}`;
      });

    expect(
      s.capability.rate,
      `capability ${s.capability.passed}/${s.capability.total}` +
        (failed.length ? `\nfailed:\n${failed.join("\n")}` : ""),
    ).toBeGreaterThanOrEqual(suite.capabilityFloor);
  });

  it("ran every case", () => {
    // Guards the guard: if a case silently never executed, the floor above
    // was computed over a smaller suite.
    expect(results.size).toBe(suite.cases.length);
  });
});
