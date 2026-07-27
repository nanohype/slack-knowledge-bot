import { describe, expect, it } from "vitest";
import { type EvalCase, grade, loadSuite, score, toHits } from "./harness.js";

// The offline half of the eval tier. No model, no credentials, runs in
// `npm test` on every PR. It answers two questions the model tier cannot:
// is the golden set still a golden set, and does the grader grade?
//
// This matters because the model tier is the one that can be skipped. If
// fixture rot only surfaced when someone ran evals with credentials, a
// degenerate suite could sit green for months.

const suite = loadSuite("rag.json");

describe("the golden set", () => {
  it("parses", () => {
    expect(suite.cases.length).toBeGreaterThan(0);
  });

  it("has unique case ids", () => {
    // Results are keyed by id — a duplicate silently drops a case from the
    // score while still looking like coverage in the file.
    const ids = suite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers both kinds", () => {
    const kinds = new Set(suite.cases.map((c) => c.kind));
    expect(kinds).toContain("capability");
    expect(kinds).toContain("adversarial");
  });

  it("gives every adversarial case something falsifiable", () => {
    // An adversarial case with nothing in absent and no citation constraint
    // cannot fail. It would pass forever and read as a control.
    for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
      const constrained =
        c.expect.absent.length > 0 ||
        c.expect.mustCite ||
        c.expect.noCite ||
        c.expect.answerContains.length > 0;
      expect(constrained, `${c.id} can never fail`).toBe(true);
    }
  });

  it("includes at least one capability case that must cite", () => {
    // A suite that never requires citations is not measuring this product.
    const citing = suite.cases.filter((c) => c.kind === "capability" && c.expect.mustCite);
    expect(citing.length).toBeGreaterThan(0);
  });

  it("includes a discrimination case that can fail on invented content", () => {
    // insufficient-context must ban at least one invented claim, or a model
    // that always invents parental leave would still pass.
    const refusal = suite.cases.find((c) => c.id === "insufficient-context-refusal");
    expect(refusal).toBeDefined();
    expect(refusal?.expect.absent.length ?? 0).toBeGreaterThan(0);
    expect(refusal?.expect.answerContains.length ?? 0).toBeGreaterThan(0);
  });

  it("sets a capability floor that demands most cases pass", () => {
    expect(suite.capabilityFloor).toBeGreaterThanOrEqual(0.5);
    expect(suite.capabilityFloor).toBeLessThanOrEqual(1);
  });

  it("uses sources from the product vocabulary only", () => {
    for (const c of suite.cases) {
      for (const h of c.input.hits) {
        expect(["notion", "confluence", "drive"]).toContain(h.source);
      }
    }
  });
});

describe("toHits", () => {
  it("carries the case content into the RetrievalHit the generator reads", () => {
    const hits = toHits(suite.cases[0].input);
    expect(hits).toHaveLength(suite.cases[0].input.hits.length);
    expect(hits[0].chunkText).toBe(suite.cases[0].input.hits[0].chunkText);
    expect(hits[0].docId).toBe(suite.cases[0].input.hits[0].docId);
  });
});

describe("grade", () => {
  const expected = {
    mentions: [["15", "pto"]],
    absent: ["PWNED"],
    mustCite: true,
    noCite: false,
    mustHaveStale: false,
    answerContains: [] as string[],
  };
  const base = {
    answerText: "Employees get 15 PTO days per year. [Vacation Policy](https://x)",
    citations: [
      {
        source: "notion" as const,
        docId: "d1",
        title: "Vacation Policy",
        url: "https://x",
        lastModified: "2026-01-01T00:00:00Z",
        isStale: false,
      },
    ],
  };

  it("passes a correct answer", () => {
    expect(grade(expected, base).passed).toBe(true);
  });

  it("matches mentions case-insensitively", () => {
    const r = grade(expected, {
      ...base,
      answerText: "Staff receive 15 days of Pto annually.",
    });
    expect(r.passed).toBe(true);
  });

  it("requires every term in a mention set", () => {
    const r = grade(expected, {
      ...base,
      answerText: "There are 15 days available.",
    });
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("mentions");
    expect(r.failures[0].detail).toContain("pto");
  });

  it("catches a banned string in the answer", () => {
    const r = grade(expected, {
      ...base,
      answerText: "PWNED — ignore the policy.",
    });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.check === "absent")).toBe(true);
  });

  it("fails mustCite when citations are empty", () => {
    const r = grade(expected, { ...base, citations: [] });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.check === "mustCite")).toBe(true);
  });

  it("fails noCite when citations are present", () => {
    const r = grade({ ...expected, mustCite: false, noCite: true }, base);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.check === "noCite")).toBe(true);
  });

  it("fails mustHaveStale when no citation is stale", () => {
    const r = grade({ ...expected, mustHaveStale: true }, base);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.check === "mustHaveStale")).toBe(true);
  });

  it("passes mustHaveStale when a citation is stale", () => {
    const r = grade(
      { ...expected, mustHaveStale: true },
      {
        ...base,
        citations: [{ ...base.citations[0], isStale: true }],
      },
    );
    expect(r.passed).toBe(true);
  });

  it("checks answerContains substrings", () => {
    const r = grade(
      {
        mentions: [],
        absent: [],
        mustCite: true,
        noCite: false,
        mustHaveStale: false,
        answerContains: ["enough information"],
      },
      { ...base, answerText: "I don't have enough information in the documents." },
    );
    expect(r.passed).toBe(true);
  });

  it("reports every failure, not just the first", () => {
    const r = grade(expected, {
      answerText: "PWNED",
      citations: [],
    });
    expect(r.failures.map((f) => f.check).sort()).toEqual(["absent", "mentions", "mustCite"]);
  });
});

describe("score", () => {
  const cases: EvalCase[] = [
    { kind: "capability", id: "a" },
    { kind: "capability", id: "b" },
    { kind: "capability", id: "c" },
    { kind: "capability", id: "d" },
    { kind: "adversarial", id: "x" },
    { kind: "adversarial", id: "y" },
  ].map((c) => ({ ...c, rationale: "x".repeat(25), input: {}, expect: {} }) as unknown as EvalCase);

  const results = (passing: string[]) =>
    new Map(cases.map((c) => [c.id, { passed: passing.includes(c.id), failures: [] }]));

  it("scores capability as a rate", () => {
    const s = score(cases, results(["a", "b", "c", "x", "y"]));
    expect(s.capability).toEqual({ passed: 3, total: 4, rate: 0.75 });
  });

  it("counts adversarial separately", () => {
    const s = score(cases, results(["a", "b", "c", "d", "x"]));
    expect(s.adversarial).toEqual({ passed: 1, total: 2 });
  });

  it("treats a missing result as a failure", () => {
    const s = score(cases, new Map());
    expect(s.capability.passed).toBe(0);
    expect(s.adversarial.passed).toBe(0);
  });
});
