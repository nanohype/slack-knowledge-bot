# Integrations

Every third-party integration is behind a typed port (`createXxx(deps)` factory). Swapping a provider means writing one new factory that satisfies the same interface and wiring it in `src/index.ts` — no changes to the pipeline, tests, or downstream consumers.

---

## WorkOS — Workforce Identity (Directory Sync)

| | |
|---|---|
| **What it does** | Maps Slack user → canonical workforce-directory user (`externalUserId`) so downstream services (OAuth token lookup, audit trail, ACL) have a stable user identity that isn't Slack-specific. |
| **Port** | `IdentityResolver` (`src/identity/types.ts`) |
| **Factory** | `createWorkOSResolver({fetchImpl, ddbClient, workosApiKey, workosDirectoryId, …})` (`src/identity/workos-resolver.ts`) |
| **API surface** | `GET https://api.workos.com/directory_users?directory={id}&limit=100` (paginated) with `Authorization: Bearer {apiKey}`. Client-filters the response by email — the endpoint doesn't support an `email=` query param (returns 422). |
| **Env vars** | `WORKOS_API_KEY`, `WORKOS_DIRECTORY_ID` — both in Secrets Manager `almanac/{env}/app-secrets` |
| **Setup** | [dashboard.workos.com](https://dashboard.workos.com) → sign up (gmail OK) → **Directory Sync** → connect your workforce directory (Google Workspace, Azure AD, Okta, manual CSV, …) → copy the `directory_01…` ID → **API Keys** → create a Production key (`sk_…`) |
| **Verify** | `npm test -- --grep workos-resolver` (Bearer auth shape, directory filter, primary-email selection, cache hit/miss, null fallover, custom baseUrl, multi-page `after` cursor pagination) |
| **Swap to** | Okta (`createOktaResolver`), Azure Entra (`createEntraResolver`), Google Admin SDK, or a local JSON directory file. Implement `IdentityResolver` and wire in `src/index.ts`. |

---

## Slack — Bot + Slash Commands

| | |
|---|---|
| **What it does** | Receives user questions (`@almanac …`, DMs) and slash commands (`/almanac disconnect`). Sends Block Kit replies (answers, citations, OAuth prompts, error messages). Fetches user profile emails via `users.info`. |
| **Port** | Slack Bolt `App` — the query handler and disconnect command register via `registerWith(app)`. Not abstracted behind a port because Slack is the product surface, not a swappable backend. |
| **Factory** | `createQueryHandler(deps)` (`src/slack/query-handler.ts`), `createDisconnectCommand(deps)` (`src/slack/disconnect-command.ts`) |
| **Env vars** | `SLACK_BOT_TOKEN` (`xoxb-…`), `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (`xapp-…`) — all in Secrets Manager |
| **Setup** | [api.slack.com/apps](https://api.slack.com/apps) → create app → **Socket Mode** on → **App-Level Token** with `connections:write` → **OAuth & Permissions** scopes: `app_mentions:read`, `chat:write`, `commands`, `im:history`, `users:read`, `users:read.email` → **Slash Commands** → `/almanac` → install to workspace |
| **Verify** | `npm test -- --grep "disconnect-command\|query-handler"` (disconnect ack + revoke flow; full query-handler integration scenarios) |

---

## Notion — Per-User Document ACL + Retrieval

| | |
|---|---|
| **What it does** | ACL probe: verifies the asking user can read a Notion page before including it in the answer. The probe hits `GET /v1/pages/{id}` with the user's own OAuth token. |
| **Port** | `ConnectorVerifier` (`src/connectors/registry.ts`) — probe receives `fetchImpl` |
| **Factory** | Side-effect registration in `src/connectors/notion.ts`; ACL guard via `createAclGuard({fetchImpl})` (`src/connectors/acl-guard.ts`) |
| **OAuth** | Authorization Code + PKCE via `almanac-oauth` (Notion provider). Per-user tokens stored in DDB + KMS. |
| **Env vars** | `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` (Secrets Manager) |
| **Setup** | [notion.so/my-integrations](https://www.notion.so/my-integrations) → new **public** integration → type: OAuth → redirect URI `https://{APP_BASE_URL}/oauth/notion/callback` |
| **Verify** | `npm test -- --grep acl-guard` (200/403/404/null-token/network-error paths, per-source routing, circuit-breaker trip → fail-secure) |

---

## Atlassian / Confluence — Per-User Document ACL + Retrieval

| | |
|---|---|
| **What it does** | ACL probe: verifies the user can read a Confluence page via `GET /wiki/rest/api/content/{id}`. Same fail-secure posture as Notion. |
| **Port** | `ConnectorVerifier` (`src/connectors/confluence.ts`) |
| **OAuth** | Authorization Code + PKCE via `almanac-oauth` (Atlassian provider). Scopes: `read:confluence-content.all`, `read:confluence-space.summary`, `offline_access`. |
| **Env vars** | `CONFLUENCE_OAUTH_CLIENT_ID`, `CONFLUENCE_OAUTH_CLIENT_SECRET` (Secrets Manager) |
| **Setup** | [developer.atlassian.com](https://developer.atlassian.com/console/myapps/) → create OAuth 2.0 (3LO) app → redirect URI `https://{APP_BASE_URL}/oauth/atlassian/callback` → enable scopes above |
| **Verify** | Covered by acl-guard tests (source-routing test hits the Confluence probe URL) |

---

## Google Drive — Per-User Document ACL + Retrieval

| | |
|---|---|
| **What it does** | ACL probe: verifies the user can read a Drive file via `GET /drive/v3/files/{id}`. Same fail-secure posture. |
| **Port** | `ConnectorVerifier` (`src/connectors/drive.ts`) |
| **OAuth** | Authorization Code + PKCE via `almanac-oauth` (Google provider). Scope: `https://www.googleapis.com/auth/drive.readonly`. |
| **Env vars** | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (Secrets Manager) |
| **Setup** | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → **Web application** OAuth client → redirect URI `https://{APP_BASE_URL}/oauth/google/callback` → enable Drive API |
| **Verify** | Covered by acl-guard tests |

---

## Amazon Bedrock — LLM + Embeddings

| | |
|---|---|
| **What it does** | Two calls per query: (1) embed the user's question via Titan for k-NN search, (2) generate the grounded answer via Claude Sonnet 4.6 with the verified-accessible documents as context. |
| **Port** | `BedrockRuntimeClient` (AWS SDK v3). Factories accept the client directly — no custom port type because the SDK is already a typed client. |
| **Factory** | `createRetriever({openSearch, bedrock, embeddingModelId})` (`src/rag/retriever.ts`), `createGenerator({bedrock, llmModelId, staleThresholdDays, …})` (`src/rag/generator.ts`) |
| **Auth** | IAM — the ECS task role is granted `bedrock:InvokeModel` on the specific model ARNs. No API key. |
| **Env vars** | `BEDROCK_REGION` (default `us-west-2`), `BEDROCK_LLM_MODEL_ID` (default `anthropic.claude-sonnet-4-6`), `BEDROCK_EMBEDDING_MODEL_ID` (default `amazon.titan-embed-text-v2:0`) |
| **Setup** | Enable model access in the AWS Console → Bedrock → Model access → request access to Claude Sonnet 4.6 + Titan Embeddings v2. IAM permissions are handled by the CDK stack. |
| **Verify** | `npm test -- --grep "retriever\|generator"` (RRF fusion ranking + dedup, Bedrock failure paths, stale-citation marker, circuit-breaker trip → empty hits) |
| **Security** | Model invocation logging is force-disabled by the CDK stack via `AwsCustomResource` calling `deleteModelInvocationLoggingConfiguration` — source content never reaches CloudWatch or S3 logs. See `docs/threat-model.md`. |

---

## pgvector on RDS — Hybrid Search

| | |
|---|---|
| **What it does** | k-NN (vector) + BM25 (keyword) retrieval over a `chunks` table in Postgres, fused via Reciprocal Rank Fusion. A generated `tsvector` column handles BM25; the `vector` extension handles k-NN via `<=>` cosine distance + IVFFlat index. |
| **Port** | `RetrievalBackend` (`src/rag/backends/types.ts`) — two methods: `knnSearch({embedding, topK})` and `textSearch({query, topK})`, each returning `RetrievalHit[]`. Any implementation plugs in. |
| **Factory** | `createRetriever({backend, bedrock, embeddingModelId})` + `createPgvectorBackend({query, embeddingDim})` |
| **Auth** | RDS master credentials auto-generated into Secrets Manager; ECS injects them as `PGUSER` / `PGPASSWORD`. Task SG has a dedicated ingress rule to the DB SG on 5432. No public ingress. |
| **Env vars** | `RETRIEVAL_BACKEND_URL` (takes precedence) OR the individual `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` fields (CDK-injected from RDS + Secrets Manager). Empty → null backend (retriever returns empty hits). |
| **Setup** | CDK provisions an RDS Postgres `db.t4g.micro` in the private subnet. Schema bootstrap (`CREATE EXTENSION vector` + `CREATE TABLE chunks` + indexes) runs idempotently at app startup. Ingestion (embedding + writing to `chunks`) is a separate pipeline, out of scope here. |
| **Verify** | `npm test -- --grep "retriever\|pgvector\|null"` (backend port shape, pgvector SQL parameterisation, null fallback, retriever fusion) |
| **Swap to** | OpenSearch, Qdrant, Pinecone, or a local stub — write a new adapter implementing `RetrievalBackend`, wire it in `src/index.ts` by extending the URL-scheme dispatcher. |

---

## ElastiCache Redis — Rate Limiting

| | |
|---|---|
| **What it does** | Shared-state sliding-window rate limiter (per-user + per-workspace). Multi-instance ECS requires shared state; in-memory Maps would multiply the limit by instance count. Fails open if Redis is unreachable. |
| **Port** | `RateLimiterRedisPort` (`src/ratelimit/redis-limiter.ts`) — narrow interface: `pipeline()` returning sorted-set operations. |
| **Factory** | `createRateLimiter({redis, userPerHour, workspacePerHour})` |
| **Auth** | VPC + TLS (`rediss://`), `rejectUnauthorized: true`. No API key. |
| **Env vars** | `REDIS_URL` (the `rediss://` endpoint) |
| **Setup** | CDK stack creates the ElastiCache cluster. No manual setup needed beyond deploy. |
| **Verify** | `npm test -- --grep redis-limiter` (under-limit/blocked/fail-open paths) |

---

## AWS SQS — Audit Event Queue

| | |
|---|---|
| **What it does** | At-least-once delivery for audit events (query + revocation). Primary queue → DLQ on failure → `AuditTotalLoss` metric if both fail. A Lambda consumer drains the queue into DDB (hot, 90d TTL) + S3 (archive, 1yr). |
| **Port** | `SQSClient` (AWS SDK v3) via `createAuditLogger({sqs, queueUrl, dlqUrl, …})` |
| **Auth** | IAM — task role has `sqs:SendMessage` on the specific queue ARNs. |
| **Env vars** | `SQS_AUDIT_QUEUE_URL`, `SQS_AUDIT_DLQ_URL` |
| **Setup** | CDK stack creates the queues + Lambda consumer. No manual setup. |
| **Verify** | `npm test -- --grep audit-logger` (primary → DLQ → total-loss fallover) |

---

## Summary table

| Integration | Port / Interface | Auth | Env vars | Swappable? |
|---|---|---|---|---|
| WorkOS | `IdentityResolver` | Bearer API key | `WORKOS_API_KEY`, `WORKOS_DIRECTORY_ID` | Yes — implement `IdentityResolver` |
| Slack | Bolt `App` (product surface) | Bot + Signing + App tokens | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | No (product boundary) |
| Notion | `ConnectorVerifier` | Per-user OAuth | `NOTION_OAUTH_CLIENT_ID/SECRET` | Yes — register a new verifier |
| Confluence | `ConnectorVerifier` | Per-user OAuth | `CONFLUENCE_OAUTH_CLIENT_ID/SECRET` | Yes — register a new verifier |
| Google Drive | `ConnectorVerifier` | Per-user OAuth | `GOOGLE_OAUTH_CLIENT_ID/SECRET` | Yes — register a new verifier |
| Bedrock | `BedrockRuntimeClient` | IAM | `BEDROCK_REGION`, `BEDROCK_LLM_MODEL_ID`, `BEDROCK_EMBEDDING_MODEL_ID` | Yes — pass a different LLM client |
| Retrieval (pgvector) | `RetrievalBackend` | RDS + Secrets Manager | `RETRIEVAL_BACKEND_URL` or `PG*` fields | Yes — any implementation of the two-method port |
| Redis | `RateLimiterRedisPort` | VPC + TLS | `REDIS_URL` | Yes — any sorted-set-shaped backend |
| SQS | `SQSClient` | IAM | `SQS_AUDIT_QUEUE_URL`, `SQS_AUDIT_DLQ_URL` | Yes — pass a different queue client |
