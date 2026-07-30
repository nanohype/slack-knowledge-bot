import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalHit } from "../connectors/types.js";
import type { RetrievalBackend } from "./backends/types.js";
import { createRetriever, rrfFusion } from "./retriever.js";

const GATEWAY = "http://gw.tenants-x.svc.cluster.local:8080";
const DIM = 3;

/**
 * Stubs the embeddings endpoint at `fetch`, so the gateway helper's own request
 * building, parsing and width check all run for real — only the response is faked.
 */
const fetchMock = vi.fn();

/** Route config shared by every retriever built here. */
const MODEL_DEPS = {
  gatewayEndpoint: GATEWAY,
  embeddingRoute: "embeddings",
  embeddingDimensions: DIM,
};

function embeddingsRespond(embedding: number[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding }] }),
  });
}

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
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("embeds through the gateway's embeddings route and returns the vector", async () => {
    embeddingsRespond([0.1, 0.2, 0.3]);
    const { backend } = fakeBackend([], []);
    const retriever = createRetriever({ backend, ...MODEL_DEPS });

    const vec = await retriever.embedQuery("hello");

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GATEWAY}/v1/embeddings`);
    const body = JSON.parse(init.body as string);
    // A route name, not a model id — the gateway rewrites it to Titan upstream.
    // `dimensions` has to travel: the pgvector column is declared at that width,
    // and the gateway forwards it to Titan.
    expect(body).toEqual({ model: "embeddings", input: "hello", dimensions: DIM });
  });

  it("refuses a vector whose width does not match the pgvector column", async () => {
    // pgvector rejects a wrong-width vector at insert, far from the cause. A
    // route repointed at a model with a different output size is exactly how
    // that happens, so it fails at the call instead.
    embeddingsRespond([0.1, 0.2]);
    const { backend } = fakeBackend([], []);
    const retriever = createRetriever({ backend, ...MODEL_DEPS });

    await expect(retriever.embedQuery("hello")).rejects.toThrow(/2-dimension vector, expected 3/);
  });

  it("surfaces the gateway's error body rather than a bare status", async () => {
    // The gateway reports a translation refusal — an unmatched route, a batch it
    // will not accept — in the body. Without it those are indistinguishable
    // from an upstream model failure.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "no matching route for model=embeddings",
    });
    const { backend } = fakeBackend([], []);
    const retriever = createRetriever({ backend, ...MODEL_DEPS });

    await expect(retriever.embedQuery("hello")).rejects.toThrow(/no matching route/);
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
      ...MODEL_DEPS,
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
      ...MODEL_DEPS,
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
      ...MODEL_DEPS,
      onCounter,
    });

    // Five failures trip the default breaker (failureThreshold: 5).
    for (let i = 0; i < 5; i++) {
      await expect(retriever.hybridSearch("q", [0.1])).rejects.toThrow("pg-down");
    }
    expect(onCounter).toHaveBeenCalledWith("circuit.open", 1, { source: "retrieval" });
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
