/**
 * pgvector-backed `RetrievalBackend`. Two SQL queries over a single
 * `chunks` table that holds both the vector embedding and a generated
 * tsvector column for keyword search.
 *
 * - k-NN: `embedding <=> $1::vector` (cosine distance) ORDER BY + LIMIT.
 *   Uses an IVFFlat index created by `pgvector-schema.ts`.
 * - Text: `ts_rank_cd(fts, plainto_tsquery('english', $1))` ORDER BY,
 *   backed by a GIN index on the generated `fts` column.
 *
 * Port-injected `PgQueryPort` is a narrow subset of `pg.Pool.query`:
 * takes a SQL string + parameter array, returns `{ rows: T[] }`. Tests
 * pass a fake implementing just that shape — no `vi.mock("pg")`.
 *
 * Vector literals are passed as `"[0.1,0.2,…]"` strings and cast to
 * `::vector` in the query. This avoids hand-building binary VECTOR
 * wire format and works with any pg driver.
 */
import type { RetrievalBackend } from "./types.js";
import type { RetrievalHit } from "../../connectors/types.js";

export interface PgQueryPort {
  query<T = unknown>(text: string, values: unknown[]): Promise<{ rows: T[] }>;
}

export interface PgvectorBackendConfig {
  query: PgQueryPort;
  embeddingDim: number;
}

interface ChunkRow {
  doc_id: string;
  source: string;
  source_url: string | null;
  title: string | null;
  chunk_text: string;
  last_modified: Date | string | null;
  score: number;
}

const KNN_SQL = `
  SELECT doc_id, source, source_url, title, chunk_text, last_modified,
         1 - (embedding <=> $1::vector) AS score
  FROM chunks
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT $2
`;

const TEXT_SQL = `
  SELECT doc_id, source, source_url, title, chunk_text, last_modified,
         ts_rank_cd(fts, plainto_tsquery('english', $1)) AS score
  FROM chunks
  WHERE fts @@ plainto_tsquery('english', $1)
  ORDER BY score DESC
  LIMIT $2
`;

export function createPgvectorBackend(deps: PgvectorBackendConfig): RetrievalBackend {
  function vectorLiteral(embedding: number[]): string {
    if (embedding.length !== deps.embeddingDim) {
      throw new Error(
        `pgvector: embedding dim ${embedding.length} does not match configured ${deps.embeddingDim}`,
      );
    }
    return `[${embedding.join(",")}]`;
  }

  function mapRow(row: ChunkRow): RetrievalHit {
    return {
      docId: row.doc_id,
      source: row.source as "notion" | "confluence" | "drive",
      title: row.title ?? "",
      url: row.source_url ?? "",
      chunkText: row.chunk_text,
      lastModified:
        row.last_modified instanceof Date
          ? row.last_modified.toISOString()
          : (row.last_modified ?? ""),
      score: Number(row.score) || 0,
      accessVerified: false,
      wasRedacted: false,
    };
  }

  return {
    async knnSearch({ embedding, topK }) {
      const { rows } = await deps.query.query<ChunkRow>(KNN_SQL, [vectorLiteral(embedding), topK]);
      return rows.map(mapRow);
    },

    async textSearch({ query, topK }) {
      const { rows } = await deps.query.query<ChunkRow>(TEXT_SQL, [query, topK]);
      return rows.map(mapRow);
    },
  };
}
