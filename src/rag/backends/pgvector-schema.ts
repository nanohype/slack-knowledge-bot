/**
 * Idempotent schema bootstrap for the pgvector retrieval backend.
 *
 * Called once from `src/index.ts` on app start. Every statement is
 * `IF NOT EXISTS` so concurrent task boots and subsequent deploys are
 * safe. If the DB is unreachable or the `vector` extension isn't
 * available, the caller logs and continues — retrieval simply errors at
 * query time until the schema exists.
 *
 * DDL runs on a dedicated client in one transaction with the per-statement
 * timeout lifted: the IVFFlat index build on a populated table can exceed the
 * pool's hot-path `statement_timeout` (5s). `SET LOCAL` auto-reverts at COMMIT,
 * so the connection returns to the pool with the hot-path cap intact.
 *
 * Embedding dimension is parameterized because it has to match what
 * the bedrock-runtime embedding model returns. Titan Embeddings v2
 * defaults to 1024.
 */
import type { Pool } from "pg";

export interface InitSchemaConfig {
  pool: Pool;
  embeddingDim: number;
}

export async function initSchema(deps: InitSchemaConfig): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");

    // `vector` extension provides the VECTOR type + `<=>` / `<#>` / `<->`
    // distance operators. Available on RDS Postgres 15+ and Aurora
    // Postgres 15+ out of the box.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    // `chunks` table. A document chunks into many overlapping segments, so the
    // key is (doc_id, chunk_index) — a plain `doc_id PRIMARY KEY` would cap each
    // document to a single row. Hits are deduped by doc_id during RRF fusion
    // (retriever.ts); note that fusion runs AFTER the per-query LIMIT, so a real
    // multi-chunk ingester would also want DISTINCT ON (doc_id) or a wider
    // candidate pool here so one document's chunks don't crowd out others. The
    // current seeder writes one chunk per doc (chunk_index 0), so it's moot today.
    // `fts` is a generated tsvector column so BM25-style ranking stays on the
    // read path without a second write per row.
    await client.query(
      `CREATE TABLE IF NOT EXISTS chunks (
         doc_id         TEXT NOT NULL,
         chunk_index    INT NOT NULL DEFAULT 0,
         source         TEXT NOT NULL,
         source_url     TEXT,
         title          TEXT,
         chunk_text     TEXT NOT NULL,
         last_modified  TIMESTAMPTZ,
         embedding      VECTOR(${deps.embeddingDim}),
         fts            TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED,
         PRIMARY KEY (doc_id, chunk_index)
       )`,
    );

    // IVFFlat over cosine distance — good balance of recall and build
    // cost for <~1M rows. For >1M, consider HNSW (`USING hnsw`) with
    // ef_construction tuning.
    await client.query(
      `CREATE INDEX IF NOT EXISTS chunks_embedding_idx
         ON chunks USING ivfflat (embedding vector_cosine_ops)
         WITH (lists = 100)`,
    );

    // GIN over the generated tsvector for the BM25 path.
    await client.query("CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING GIN (fts)");

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
