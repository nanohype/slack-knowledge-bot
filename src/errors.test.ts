import { describe, expect, it } from "vitest";
import { asError, errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("uses the message of a real Error", () => {
    expect(errorMessage(new Error("ProvisionedThroughputExceeded"))).toBe(
      "ProvisionedThroughputExceeded",
    );
  });

  it("stringifies a bare throw", () => {
    // The arm that matters: a transport or middleware that throws a string, or
    // a rejected promise carrying a plain value. Without this the log line reads
    // "[object Object]" or the handler throws while handling an error.
    expect(errorMessage("ETIMEDOUT")).toBe("ETIMEDOUT");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(500)).toBe("500");
  });

  it("does not throw on an object with no message", () => {
    expect(() => errorMessage({ code: "ECONNRESET" })).not.toThrow();
  });
});

describe("asError", () => {
  it("passes a real Error through unchanged, preserving its stack", () => {
    const err = new Error("boom");
    expect(asError(err)).toBe(err);
  });

  it("wraps a non-Error so callers that require an Error get one", () => {
    const wrapped = asError("boom");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("boom");
  });
});
