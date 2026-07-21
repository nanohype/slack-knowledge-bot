import { describe, expect, it } from "vitest";
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

  it("ignores the traceId argument", async () => {
    // The context's `traceId` is discarded — OTel owns trace IDs.
    const ok = await requestContext.run({ traceId: "ignored" }, async () => 42);
    expect(ok).toBe(42);
  });
});
