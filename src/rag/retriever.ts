/**
 * Hybrid retriever: k-NN + lexical (BM25-style) with Reciprocal Rank
 * Fusion. Both search methods are delegated to a `RetrievalBackend`
 * port (null, pgvector, or a client-supplied implementation) — this
 * module owns the query-embedding call against Bedrock Titan and the
 * fusion logic; the backend owns the wire format.
 *
 * The pure `rrfFusion` is exported for direct coverage.
 *
 * The retrieval backend (k-NN + BM25) is wrapped in a single circuit
 * breaker so a tar-pitted Postgres (or pgvector extension hiccup)
 * doesn't stall the whole bot. When the breaker is open we log and
 * return empty hits — the generator handles the empty-context case
 * gracefully. Bedrock (embeddings) is intentionally NOT on the same
 * breaker: Bedrock has its own retry/backoff, and an embedding failure
 * on one query doesn't spare the next.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { RetrievalHit } from "../connectors/types.js";
import type { RetrievalBackend } from "./backends/types.js";
import { logger } from "../logger.js";
import { CircuitOpenError, createCircuitBreaker } from "../util/circuit-breaker.js";

const EmbeddingResponseSchema = z.object({
  embedding: z.array(z.number()).min(1),
});

const TOP_K = 20;
const FINAL_K = 10;
const EMBED_TIMEOUT_MS = 5000;
const BREAKER_NAME = "retrieval";
const FAILURE_THRESHOLD = 5;
const WINDOW_MS = 60_000;
const HALF_OPEN_AFTER_MS = 30_000;

export interface RetrieverConfig {
  backend: RetrievalBackend;
  bedrock: BedrockRuntimeClient;
  embeddingModelId: string;
  onTiming?: (metric: string, ms: number) => void;
  onCounter?: (metric: string, value?: number, dims?: Record<string, string>) => void;
  /** Test hook — override the wall clock used by the retrieval breaker. */
  now?: () => number;
}

export interface Retriever {
  embedQuery(queryText: string): Promise<number[]>;
  hybridSearch(queryText: string, queryEmbedding: number[]): Promise<RetrievalHit[]>;
}

export function createRetriever(deps: RetrieverConfig): Retriever {
  const timing = deps.onTiming ?? (() => {});
  const counter = deps.onCounter ?? (() => {});
  const breaker = createCircuitBreaker({
    name: BREAKER_NAME,
    failureThreshold: FAILURE_THRESHOLD,
    windowMs: WINDOW_MS,
    halfOpenAfterMs: HALF_OPEN_AFTER_MS,
    now: deps.now,
    onOpen: (n) => counter("circuit_open_total", 1, { source: n }),
  });

  return {
    async embedQuery(queryText) {
      const start = Date.now();
      const response = await deps.bedrock.send(
        new InvokeModelCommand({
          modelId: deps.embeddingModelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: queryText }),
        }),
        { abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS) },
      );
      timing("EmbeddingLatency", Date.now() - start);
      const raw: unknown = JSON.parse(new TextDecoder().decode(response.body));
      const parsed = EmbeddingResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error(
          { modelId: deps.embeddingModelId, err: parsed.error.issues },
          "Bedrock embedding response did not match expected shape",
        );
        throw new Error("Bedrock embedding response invalid");
      }
      return parsed.data.embedding;
    },

    async hybridSearch(queryText, queryEmbedding) {
      const start = Date.now();
      try {
        const [knnHits, textHits] = await breaker.exec(() =>
          Promise.all([
            deps.backend.knnSearch({ embedding: queryEmbedding, topK: TOP_K }),
            deps.backend.textSearch({ query: queryText, topK: TOP_K }),
          ]),
        );
        timing("RetrievalLatency", Date.now() - start);
        const knnRanked = knnHits.map((hit, index) => ({ hit, rank: index + 1 }));
        const textRanked = textHits.map((hit, index) => ({ hit, rank: index + 1 }));
        const fused = rrfFusion(knnRanked, textRanked, FINAL_K);
        logger.debug(
          { knnCount: knnHits.length, textCount: textHits.length, fusedCount: fused.length },
          "hybrid search",
        );
        return fused;
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          logger.warn(
            { breaker: BREAKER_NAME },
            "retrieval short-circuited (breaker open), returning empty hits",
          );
          return [];
        }
        throw err;
      }
    },
  };
}

export function rrfFusion(
  knnRanked: Array<{ hit: RetrievalHit; rank: number }>,
  textRanked: Array<{ hit: RetrievalHit; rank: number }>,
  topK: number,
): RetrievalHit[] {
  const RRF_K = 60;
  const scores = new Map<string, { hit: RetrievalHit; score: number }>();
  for (const { hit, rank } of knnRanked) {
    const rrfScore = 1 / (RRF_K + rank);
    const existing = scores.get(hit.docId);
    if (existing) existing.score += rrfScore;
    else scores.set(hit.docId, { hit, score: rrfScore });
  }
  for (const { hit, rank } of textRanked) {
    const rrfScore = 1 / (RRF_K + rank);
    const existing = scores.get(hit.docId);
    if (existing) existing.score += rrfScore;
    else scores.set(hit.docId, { hit, score: rrfScore });
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score }));
}
