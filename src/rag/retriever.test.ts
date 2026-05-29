import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createRetriever, rrfFusion } from "./retriever.js";
import type { RetrievalBackend } from "./backends/types.js";
import type { RetrievalHit } from "../connectors/types.js";

const bedrockMock = mockClient(BedrockRuntimeClient);

function baseHit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    docId: "d1",
    source: "notion",
    title: "T",
    url: "u",
    chunkText: "c",
    lastModified: "2026-04-01",
    score: 0,
    accessVerified: false,
    wasRedacted: false,
    ...overrides,
  };
}

function fakeBackend(
  knnHits: RetrievalHit[],
  textHits: RetrievalHit[],
): { backend: RetrievalBackend; knn: ReturnType<typeof vi.fn>; text: ReturnType<typeof vi.fn> } {
  const knn = vi.fn<RetrievalBackend["knnSearch"]>(async () => knnHits);
  const text = vi.fn<RetrievalBackend["textSearch"]>(async () => textHits);
  return { backend: { knnSearch: knn, textSearch: text }, knn, text };
}

describe("createRetriever — embedQuery", () => {
  beforeEach(() => bedrockMock.reset());

  it("invokes Bedrock with the configured embedding model and returns the vector", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2, 0.3] })),
    } as never);
    const { backend } = fakeBackend([], []);
    const retriever = createRetriever({
      backend,
      bedrock: new BedrockRuntimeClient({}),
      embeddingModelId: "titan-v2",
    });
    const vec = await retriever.embedQuery("hello");
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.modelId).toBe("titan-v2");
    const body = JSON.parse(calls[0].args[0].input.body as string);
    expect(body).toEqual({ inputText: "hello" });
  });
});

describe("createRetriever — hybridSearch", () => {
  it("calls both backend methods in parallel and fuses ranked lists", async () => {
    const { backend, knn, text } = fakeBackend(
      [baseHit({ docId: "a" }), baseHit({ docId: "b" })],
      [baseHit({ docId: "a" }), baseHit({ docId: "c" })],
    );
    const retriever = createRetriever({
      backend,
      bedrock: new BedrockRuntimeClient({}),
      embeddingModelId: "titan-v2",
    });

    const hits = await retriever.hybridSearch("q", [0.1, 0.2]);

    // Doc A is in both — RRF ranks it first.
    expect(hits[0].docId).toBe("a");
    expect(new Set(hits.map((h) => h.docId))).toEqual(new Set(["a", "b", "c"]));

    expect(knn).toHaveBeenCalledWith({ embedding: [0.1, 0.2], topK: 20 });
    expect(text).toHaveBeenCalledWith({ query: "q", topK: 20 });
  });

  it("returns empty when both backend methods return empty (null-backend shape)", async () => {
    const { backend } = fakeBackend([], []);
    const retriever = createRetriever({
      backend,
      bedrock: new BedrockRuntimeClient({}),
      embeddingModelId: "titan-v2",
    });
    expect(await retriever.hybridSearch("q", [0, 1, 0])).toEqual([]);
  });

  it("circuit breaker: trips after repeated failures then fails soft with empty hits", async () => {
    const knn = vi.fn<RetrievalBackend["knnSearch"]>(async () => {
      throw new Error("pg-down");
    });
    const text = vi.fn<RetrievalBackend["textSearch"]>(async () => {
      throw new Error("pg-down");
    });
    const backend: RetrievalBackend = { knnSearch: knn, textSearch: text };
    const onCounter = vi.fn();
    const retriever = createRetriever({
      backend,
      bedrock: new BedrockRuntimeClient({}),
      embeddingModelId: "titan-v2",
      onCounter,
    });

    // Five failures trip the default breaker (failureThreshold: 5).
    for (let i = 0; i < 5; i++) {
      await expect(retriever.hybridSearch("q", [0.1])).rejects.toThrow("pg-down");
    }
    expect(onCounter).toHaveBeenCalledWith("circuit_open_total", 1, { source: "retrieval" });
    expect(onCounter).toHaveBeenCalledTimes(1);

    // 6th call: breaker open → fail soft, empty hits.
    const hits = await retriever.hybridSearch("q", [0.1]);
    expect(hits).toEqual([]);
    // knn/text each called once per attempt before the trip (5 calls total each);
    // the short-circuited 6th attempt does NOT invoke the backend again.
    expect(knn).toHaveBeenCalledTimes(5);
    expect(text).toHaveBeenCalledTimes(5);
  });
});

describe("rrfFusion (pure)", () => {
  it("ranks documents that appear in both lists above docs in only one", () => {
    const both = baseHit({ docId: "both" });
    const onlyKnn = baseHit({ docId: "knn-only" });
    const onlyText = baseHit({ docId: "text-only" });
    const fused = rrfFusion(
      [
        { hit: both, rank: 1 },
        { hit: onlyKnn, rank: 2 },
      ],
      [
        { hit: both, rank: 1 },
        { hit: onlyText, rank: 2 },
      ],
      10,
    );
    expect(fused[0].docId).toBe("both");
  });

  it("dedupes by docId — a doc in both lists appears only once in the output", () => {
    const h = baseHit({ docId: "dup" });
    const fused = rrfFusion([{ hit: h, rank: 1 }], [{ hit: h, rank: 1 }], 10);
    expect(fused.filter((x) => x.docId === "dup")).toHaveLength(1);
  });

  it("caps the output at topK", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      hit: baseHit({ docId: `d-${i}` }),
      rank: i + 1,
    }));
    const fused = rrfFusion(many, [], 10);
    expect(fused).toHaveLength(10);
  });
});
