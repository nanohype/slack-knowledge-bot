/**
 * Idempotent schema bootstrap for the pgvector retrieval backend.
 *
 * Called once from `src/index.ts` on app start. Every statement is
 * `IF NOT EXISTS` so concurrent task boots and subsequent deploys are
 * safe. If the DB is unreachable or the `vector` extension isn't
 * available, the caller logs and continues — retrieval simply errors at
 * query time until the schema exists.
 *
 * Embedding dimension is parameterized because it has to match what
 * the bedrock-runtime embedding model returns. Titan Embeddings v2
 * defaults to 1024.
 */
import type { PgQueryPort } from "./pgvector.js";

export interface InitSchemaConfig {
  query: PgQueryPort;
  embeddingDim: number;
}

export async function initSchema(deps: InitSchemaConfig): Promise<void> {
  // `vector` extension provides the VECTOR type + `<=>` / `<#>` / `<->`
  // distance operators. Available on RDS Postgres 15+ and Aurora
  // Postgres 15+ out of the box.
  await deps.query.query("CREATE EXTENSION IF NOT EXISTS vector", []);

  // `chunks` table. `fts` is a generated tsvector column so BM25-style
  // ranking stays on the read path without a second write per row.
  await deps.query.query(
    `CREATE TABLE IF NOT EXISTS chunks (
       doc_id         TEXT PRIMARY KEY,
       source         TEXT NOT NULL,
       source_url     TEXT,
       title          TEXT,
       chunk_text     TEXT NOT NULL,
       last_modified  TIMESTAMPTZ,
       embedding      VECTOR(${deps.embeddingDim}),
       fts            TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED
     )`,
    [],
  );

  // IVFFlat over cosine distance — good balance of recall and build
  // cost for <~1M rows. For >1M, consider HNSW (`USING hnsw`) with
  // ef_construction tuning.
  await deps.query.query(
    `CREATE INDEX IF NOT EXISTS chunks_embedding_idx
       ON chunks USING ivfflat (embedding vector_cosine_ops)
       WITH (lists = 100)`,
    [],
  );

  // GIN over the generated tsvector for the BM25 path.
  await deps.query.query("CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING GIN (fts)", []);
}
