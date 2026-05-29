import { describe, it, expect } from "vitest";
import { requestContext } from "./context.js";

describe("requestContext.run", () => {
  it("returns the wrapped function's value (happy path)", async () => {
    const result = await requestContext.run({}, async () => "ok");
    expect(result).toBe("ok");
  });

  it("propagates the wrapped function's rejection after ending the span", async () => {
    // Error path must bubble out untouched. The span records the
    // exception (verified in Tempo, not here — that's SDK territory) but
    // does not swallow the error.
    await expect(
      requestContext.run({}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("ignores the legacy traceId argument", async () => {
    // `requestContext.run` accepts the legacy `{traceId}` shape so callers
    // don't churn; the value is discarded because OTel owns trace IDs now.
    const ok = await requestContext.run({ traceId: "legacy-ignored" }, async () => 42);
    expect(ok).toBe(42);
  });
});
