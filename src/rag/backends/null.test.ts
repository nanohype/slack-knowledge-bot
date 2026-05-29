import { describe, it, expect } from "vitest";
import { createNullBackend } from "./null.js";

describe("createNullBackend", () => {
  it("knnSearch returns empty hits", async () => {
    const backend = createNullBackend();
    expect(await backend.knnSearch({ embedding: [0.1, 0.2, 0.3], topK: 10 })).toEqual([]);
  });

  it("textSearch returns empty hits", async () => {
    const backend = createNullBackend();
    expect(await backend.textSearch({ query: "anything", topK: 10 })).toEqual([]);
  });
});
