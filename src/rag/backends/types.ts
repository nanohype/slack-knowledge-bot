/**
 * Retrieval backend port — the single interface the hybrid retriever
 * depends on. Any implementation that satisfies it (pgvector, self-
 * hosted OpenSearch, Qdrant, Pinecone, a local stub) can be swapped in
 * at `src/index.ts` bootstrap by setting `RETRIEVAL_BACKEND_URL` and
 * wiring the matching factory.
 *
 * The retriever calls both methods in parallel for every query and
 * fuses the ranked lists via Reciprocal Rank Fusion (`rrfFusion` in
 * `retriever.ts`). Backends return `RetrievalHit[]` already sorted by
 * their native relevance — the retriever only uses order, not score
 * magnitudes.
 */
import type { RetrievalHit } from "../../connectors/types.js";

export interface RetrievalBackend {
  /**
   * Vector similarity (k-nearest neighbors) search against the query's
   * embedding. Backend returns up to `topK` hits, sorted by descending
   * similarity.
   */
  knnSearch(args: { embedding: number[]; topK: number }): Promise<RetrievalHit[]>;

  /**
   * Lexical (BM25 / tsvector / keyword) search against the raw query
   * text. Backend returns up to `topK` hits, sorted by descending
   * lexical relevance.
   */
  textSearch(args: { query: string; topK: number }): Promise<RetrievalHit[]>;
}
