import { describe, it, expect, vi } from "vitest";
import { createPgvectorBackend, type PgQueryPort } from "./pgvector.js";

function fakeQuery(rowsByCall: unknown[][]): {
  port: PgQueryPort;
  spy: ReturnType<typeof vi.fn>;
} {
  const queue = [...rowsByCall];
  const queryFn = vi.fn(async () => {
    const rows = queue.shift();
    if (rows === undefined) throw new Error("fakeQuery: more query calls than rows configured");
    return { rows };
  });
  return {
    port: { query: queryFn as unknown as PgQueryPort["query"] },
    spy: queryFn,
  };
}

const EMBEDDING_DIM = 1024;

describe("createPgvectorBackend — knnSearch", () => {
  it("sends the embedding as a vector literal and respects topK", async () => {
    const rows = [
      {
        doc_id: "notion:page:p1",
        source: "notion",
        source_url: "https://notion.so/p1",
        title: "PTO policy",
        chunk_text: "Employees get 15 PTO days",
        last_modified: "2026-04-01T00:00:00Z",
        score: 0.91,
      },
    ];
    const { port: q, spy } = fakeQuery([rows]);
    const backend = createPgvectorBackend({ query: q, embeddingDim: EMBEDDING_DIM });

    const embedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
    const hits = await backend.knnSearch({ embedding, topK: 20 });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      docId: "notion:page:p1",
      source: "notion",
      title: "PTO policy",
      url: "https://notion.so/p1",
      accessVerified: false,
      wasRedacted: false,
    });

    // Vector must be `[v1,v2,…]` format and topK passed as the second param.
    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("embedding <=> $1::vector");
    expect(params[0]).toBe(`[${embedding.join(",")}]`);
    expect(params[1]).toBe(20);
  });

  it("returns empty when the chunks table has no rows yet", async () => {
    const { port: q } = fakeQuery([[]]);
    const backend = createPgvectorBackend({ query: q, embeddingDim: EMBEDDING_DIM });
    const embedding = Array.from({ length: EMBEDDING_DIM }, () => 0);
    expect(await backend.knnSearch({ embedding, topK: 10 })).toEqual([]);
  });

  it("rejects an embedding whose dim doesn't match the configured dim", async () => {
    const { port: q } = fakeQuery([]);
    const backend = createPgvectorBackend({ query: q, embeddingDim: EMBEDDING_DIM });
    await expect(backend.knnSearch({ embedding: [0.1, 0.2], topK: 10 })).rejects.toThrow(
      /embedding dim 2 does not match configured 1024/,
    );
  });
});

describe("createPgvectorBackend — textSearch", () => {
  it("ranks via plainto_tsquery and returns mapped hits in DB order", async () => {
    const rows = [
      {
        doc_id: "drive:file:a",
        source: "drive",
        source_url: "https://drive.google.com/file/a",
        title: "Vacation FAQ",
        chunk_text: "PTO accrual and carryover",
        last_modified: "2026-03-15T12:00:00Z",
        score: 0.42,
      },
      {
        doc_id: "confluence:page:b",
        source: "confluence",
        source_url: "https://acme.atlassian.net/wiki/b",
        title: "Leave policy",
        chunk_text: "PTO is granted quarterly",
        last_modified: "2025-12-01T00:00:00Z",
        score: 0.31,
      },
    ];
    const { port: q, spy } = fakeQuery([rows]);
    const backend = createPgvectorBackend({ query: q, embeddingDim: EMBEDDING_DIM });

    const hits = await backend.textSearch({ query: "PTO policy", topK: 20 });

    expect(hits.map((h) => h.docId)).toEqual(["drive:file:a", "confluence:page:b"]);
    expect(hits.map((h) => h.source)).toEqual(["drive", "confluence"]);

    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain("plainto_tsquery('english', $1)");
    expect(sql).toContain("fts @@ plainto_tsquery");
    expect(params).toEqual(["PTO policy", 20]);
  });

  it("maps a Date last_modified to its ISO string", async () => {
    const rows = [
      {
        doc_id: "notion:page:x",
        source: "notion",
        source_url: "https://notion.so/x",
        title: "x",
        chunk_text: "x",
        last_modified: new Date("2026-04-15T00:00:00Z"),
        score: 0.1,
      },
    ];
    const { port: q } = fakeQuery([rows]);
    const backend = createPgvectorBackend({ query: q, embeddingDim: EMBEDDING_DIM });
    const hits = await backend.textSearch({ query: "x", topK: 10 });
    expect(hits[0].lastModified).toBe("2026-04-15T00:00:00.000Z");
  });

  it("returns empty when there are no matching rows", async () => {
    const { port: q } = fakeQuery([[]]);
    const backend = createPgvectorBackend({ query: q, embeddingDim: EMBEDDING_DIM });
    expect(await backend.textSearch({ query: "nothing matches", topK: 10 })).toEqual([]);
  });
});
