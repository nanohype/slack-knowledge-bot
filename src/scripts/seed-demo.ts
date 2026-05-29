/**
 * One-off seeder: upserts a handful of fake company docs into the
 * `chunks` table with real Titan embeddings so the RAG pipeline has
 * something to retrieve.
 *
 * Run inside a running pod (the only thing with network access to the
 * private-subnet Aurora) via:
 *
 *   kubectl -n tenants-protohype exec -it deploy/almanac -- \
 *     node dist/scripts/seed-demo.js
 *
 * Re-running is safe (ON CONFLICT ... DO UPDATE). This is a demo
 * affordance, not an ingestion pipeline. A real ingester crawls
 * source systems + chunks real content — out of scope here.
 */
import { Pool } from "pg";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

interface SeedDoc {
  docId: string;
  source: "notion" | "confluence" | "drive";
  sourceUrl: string;
  title: string;
  chunkText: string;
  lastModified: string;
}

// ─── Operator: replace these four constants before running ─────────────────
//
// Create one page in each source with the content of the matching SEED_DOCS
// entry below (see docs/qa-playbook.md §8 and Appendix A). Grab the IDs from
// each page URL:
//
//   Notion page URL:      https://www.notion.so/<Title>-<32-char-hex>
//                         NOTION_PAGE_ID = the trailing 32-char hex
//                         (dashed or undashed — both formats work with the API)
//
//   Confluence cloudId:   curl https://<yoursite>.atlassian.net/_edge/tenant_info
//                         CONFLUENCE_CLOUD_ID = the "cloudId" field (UUID)
//
//   Confluence page URL:  https://<site>.atlassian.net/wiki/spaces/<K>/pages/<num>/<Title>
//                         CONFLUENCE_PAGE_ID = the numeric segment
//
//   Drive doc URL:        https://docs.google.com/document/d/<id>/edit
//                         DRIVE_FILE_ID = the segment between /d/ and /edit
//
// The `REPLACE_WITH_YOUR_*` sentinels trip a guard at the bottom of this
// file — the seeder refuses to run until real values are pasted in.
// ─────────────────────────────────────────────────────────────────────────────
const NOTION_PAGE_ID = "REPLACE_WITH_YOUR_NOTION_PAGE_ID";
const CONFLUENCE_CLOUD_ID = "REPLACE_WITH_YOUR_CONFLUENCE_CLOUD_ID";
const CONFLUENCE_PAGE_ID = "REPLACE_WITH_YOUR_CONFLUENCE_PAGE_ID";
const DRIVE_FILE_ID = "REPLACE_WITH_YOUR_DRIVE_FILE_ID";

const SEED_DOCS: SeedDoc[] = [
  {
    docId: `notion:page:${NOTION_PAGE_ID}`,
    source: "notion",
    sourceUrl: `https://www.notion.so/${NOTION_PAGE_ID}`,
    title: "PTO Policy",
    chunkText:
      "Full-time employees accrue paid time off at a rate of 1.25 days per month, capped at 15 days per calendar year. Unused days roll over up to a maximum of 5 days into the following year; any balance beyond that is forfeited on January 1st. Time off must be requested in Workday at least two weeks in advance, except in cases of illness or family emergency. Managers approve within three business days. The company additionally observes 10 fixed holidays per year, listed in the employee handbook.",
    lastModified: "2026-04-16T00:00:00Z",
  },
  {
    docId: `confluence:${CONFLUENCE_CLOUD_ID}:${CONFLUENCE_PAGE_ID}`,
    source: "confluence",
    sourceUrl: `https://api.atlassian.com/ex/confluence/${CONFLUENCE_CLOUD_ID}/wiki/pages/${CONFLUENCE_PAGE_ID}`,
    title: "On-call Rotation — Platform Team",
    chunkText:
      "Platform engineering on-call runs a weekly rotation, Monday 10am Pacific to Monday 10am Pacific. Primary holds the pager, secondary covers if primary is unreachable within 15 minutes. Severity 1 incidents require acknowledgment within 15 minutes and engagement within 30. Severity 2 is one hour. Hand-off is a synchronous meeting every Monday in the #eng-oncall channel where outgoing reviews open incidents, pending investigations, and any watch items. After-hours pages outside on-call duty are compensated at time-and-a-half.",
    lastModified: "2026-04-16T00:00:00Z",
  },
  {
    docId: `drive:file:${DRIVE_FILE_ID}`,
    source: "drive",
    sourceUrl: `https://docs.google.com/document/d/${DRIVE_FILE_ID}/edit`,
    title: "Q2 2026 Engineering Roadmap",
    chunkText:
      "Q2 2026 priorities for Engineering: (1) Ship the knowledge bot to general availability by end of May, with SOC 2 Type II audit fieldwork completed in parallel. (2) Migrate the legacy audit logging system to the new structured event format before June 1st to meet compliance deadlines. (3) Reduce API p95 latency from 3.2 seconds to under 2 seconds through caching, query planning improvements, and a move from t4g.micro to t4g.small database instances. (4) Launch the billing revamp behind a feature flag for 10% of tenants by end of quarter.",
    lastModified: "2026-04-16T00:00:00Z",
  },
];

function assertNoPlaceholders(): void {
  const unset = [
    ["NOTION_PAGE_ID", NOTION_PAGE_ID],
    ["CONFLUENCE_CLOUD_ID", CONFLUENCE_CLOUD_ID],
    ["CONFLUENCE_PAGE_ID", CONFLUENCE_PAGE_ID],
    ["DRIVE_FILE_ID", DRIVE_FILE_ID],
  ].filter(([, value]) => value.startsWith("REPLACE_WITH_YOUR_"));
  if (unset.length > 0) {
    const names = unset.map(([name]) => name).join(", ");
    throw new Error(
      `seed-demo: placeholder IDs still present (${names}) — replace the REPLACE_WITH_YOUR_* constants in src/scripts/seed-demo.ts with real page IDs before running. See docs/qa-playbook.md §8.`,
    );
  }
}

async function embed(
  bedrock: BedrockRuntimeClient,
  modelId: string,
  text: string,
): Promise<number[]> {
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      body: JSON.stringify({ inputText: text }),
      contentType: "application/json",
      accept: "application/json",
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding: number[];
  };
  return parsed.embedding;
}

async function main(): Promise<void> {
  assertNoPlaceholders();

  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  if (!host || !user || !password) {
    throw new Error(
      "seed-demo: PGHOST / PGUSER / PGPASSWORD missing — run inside a pod where these are injected from the ExternalSecret-synced DB credentials.",
    );
  }

  const modelId = process.env.BEDROCK_EMBEDDING_MODEL_ID ?? "amazon.titan-embed-text-v2:0";
  const bedrock = new BedrockRuntimeClient({
    region: process.env.BEDROCK_REGION ?? "us-west-2",
  });

  const pool = new Pool({
    host,
    port: Number(process.env.PGPORT ?? 5432),
    user,
    password,
    database: process.env.PGDATABASE ?? "almanac",
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  console.error(`[seed] embedding ${SEED_DOCS.length} docs via ${modelId}...`);
  for (const doc of SEED_DOCS) {
    const vector = await embed(bedrock, modelId, `${doc.title}\n${doc.chunkText}`);
    const literal = `[${vector.join(",")}]`;
    await pool.query(
      `INSERT INTO chunks (doc_id, source, source_url, title, chunk_text, last_modified, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::vector)
       ON CONFLICT (doc_id) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         title = EXCLUDED.title,
         chunk_text = EXCLUDED.chunk_text,
         last_modified = EXCLUDED.last_modified,
         embedding = EXCLUDED.embedding`,
      [doc.docId, doc.source, doc.sourceUrl, doc.title, doc.chunkText, doc.lastModified, literal],
    );
    console.error(`[seed] upserted ${doc.docId}`);
  }

  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM chunks");
  console.error(`[seed] done. total chunks in table: ${rows[0]?.count}`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
