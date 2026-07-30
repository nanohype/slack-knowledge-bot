import { z } from "zod";

const ConfigSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string(),
  SLACK_SIGNING_SECRET: z.string(),
  SLACK_APP_TOKEN: z.string(),

  // AWS
  AWS_REGION: z.string().default("us-west-2"),
  DYNAMODB_TABLE_TOKENS: z.string(),
  DYNAMODB_TABLE_AUDIT: z.string(),
  DYNAMODB_TABLE_IDENTITY_CACHE: z.string(),
  SQS_AUDIT_QUEUE_URL: z.string(),
  SQS_AUDIT_DLQ_URL: z.string(),
  // Retrieval backend URL. Empty → bootstrap wires a null backend
  // (retriever returns empty hits). `postgres://…` → pgvector. Any
  // other value fails at startup so typos don't silently fall back to
  // null. The URL is the one source-of-truth; the adapter is picked
  // by scheme in `src/index.ts`.
  //
  // Pods can leave this blank and instead get
  // PG{HOST,PORT,USER,PASSWORD,DATABASE} in their env from Aurora +
  // the ExternalSecret-synced DB credentials; bootstrap composes the URL
  // from those fields when RETRIEVAL_BACKEND_URL is empty. Takes precedence
  // over PG* if both are set.
  RETRIEVAL_BACKEND_URL: z.string().default(""),
  PGHOST: z.string().default(""),
  PGPORT: z.coerce.number().default(5432),
  PGUSER: z.string().default(""),
  PGPASSWORD: z.string().default(""),
  PGDATABASE: z.string().default("slack_knowledge_bot"),
  // Postgres TLS. RDS/Aurora present a server cert signed by the Amazon RDS
  // CA. Default verifies the cert against the bundled RDS global CA
  // (`certs/rds-global-bundle.pem`, baked into the image) so the DB link is
  // authenticated-encrypted, not just encrypted. Set
  // PG_SSL_REJECT_UNAUTHORIZED=false for a local/dev Postgres that has no
  // trusted chain. PG_SSL_CA_PATH overrides the bundle location.
  PG_SSL_REJECT_UNAUTHORIZED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  PG_SSL_CA_PATH: z.string().default("certs/rds-global-bundle.pem"),
  // .min(1), not a bare string: an empty value passes a bare z.string() and the
  // pod starts, then fails on the first envelope operation instead of at boot.
  KMS_KEY_ID: z.string().min(1),
  REDIS_URL: z.string(),

  // The model plane. Every model call goes through the Platform's ModelGateway,
  // which holds the AWS identity, applies each route's guardrail, and records
  // the request. This app holds no model credential.
  MODEL_GATEWAY_ENDPOINT: z
    .string()
    .url()
    // .url() alone accepts `host:8080` as a URL whose scheme is `host:`, which
    // the client would only fail on at request time.
    .refine((v) => /^https?:\/\//.test(v), {
      message: "MODEL_GATEWAY_ENDPOINT must be an http(s) URL",
    }),
  // Route names on that gateway, not model ids. The ModelGateway CR maps them
  // to Claude and Titan — including the `us.` cross-region inference profile
  // the Claude family requires, which now lives in the CR rather than here.
  MODEL_ROUTE: z.string().min(1).default("default"),
  EMBEDDING_ROUTE: z.string().min(1).default("embeddings"),

  // WorkOS (workforce identity — Directory Sync via SCIM)
  WORKOS_API_KEY: z.string(),
  WORKOS_DIRECTORY_ID: z.string(),

  // OAuth App credentials (used to initiate per-user OAuth)
  NOTION_OAUTH_CLIENT_ID: z.string(),
  NOTION_OAUTH_CLIENT_SECRET: z.string(),
  CONFLUENCE_OAUTH_CLIENT_ID: z.string(),
  CONFLUENCE_OAUTH_CLIENT_SECRET: z.string(),
  GOOGLE_OAUTH_CLIENT_ID: z.string(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string(),

  // App
  APP_BASE_URL: z.string(),
  RATE_LIMIT_USER_PER_HOUR: z.coerce.number().default(20),
  RATE_LIMIT_WORKSPACE_PER_HOUR: z.coerce.number().default(500),
  STALE_DOC_THRESHOLD_DAYS: z.coerce.number().default(90),

  TOKEN_STORE_ENCRYPTION_CONTEXT: z.string().default("slack-knowledge-bot-token-store"),

  // OAuth delegation (slack-knowledge-bot-oauth / module-oauth-delegation).
  // HMAC-SHA256 signing key for the state cookie AND for the signed OAuth
  // start URLs we hand to users in Slack. Must be ≥ 32 bytes of randomness.
  STATE_SIGNING_SECRET: z.string().min(32),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

function loadConfig() {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid configuration:", parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof ConfigSchema>;
