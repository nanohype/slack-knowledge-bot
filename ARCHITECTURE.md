# Architecture

`slack-knowledge-bot` (internal service handle: **slack-knowledge-bot**) is an internal Slack bot that answers employee questions over Notion, Confluence, and Google Drive — grounded in the asking user's own access-controlled documents, with every answer cited. This document covers the bounded contexts, the load-bearing decisions, the per-query data flow, and where the boundaries sit relative to the rest of the stack.

## Bounded contexts

The system organizes around seven contexts. Each is a directory of `createXxx(deps)` factories taking typed ports; `src/index.ts` is the one place real SDK clients are constructed and threaded in.

| Context        | Module path                                | What it owns                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **slack**      | `src/slack/`                               | `createQueryHandler` orchestrates the pipeline; `createDisconnectCommand` is the `/slack-knowledge-bot disconnect [source\|all]` self-service revoke; `formatter.ts` builds Block Kit replies (answers, citations, OAuth prompts, rate-limit + error messages with trace IDs)                                                                                                                                             |
| **identity**   | `src/identity/`                            | `createWorkOSResolver` maps Slack user → workforce-directory user via WorkOS Directory Sync, cached in DynamoDB (1h TTL). The raw directory calls + cursor pagination live in the vendored `src/vendor/runtime/workos-directory.ts` client; the resolver owns the cache, per-request deadlines, and the fail-soft contract. Bearer-API-key auth — no service-token refresh, no L2 cache                                   |
| **oauth**      | `src/oauth/` + `packages/oauth/`           | `createSlackKnowledgeBotOAuth` builds the OAuth router (Notion/Atlassian/Google providers + DDB+KMS storage + a revocation emitter into the audit pipeline). `url-token.ts` signs/verifies the short-lived `/start` URLs handed to users; `http.ts` bridges node:http ↔ Web-standard Request/Response. The provider adapters + storage live in the `slack-knowledge-bot-oauth` package (`file:./packages/oauth`)          |
| **connectors** | `src/connectors/`                          | `createAclGuard` verifies per-user access per source via a `ConnectorVerifier` registry (`notion.ts`/`confluence.ts`/`drive.ts`). Each source gets its own circuit breaker (threshold 5, 60s window, 30s half-open). Fail-secure                                                                                                                                                                                          |
| **rag**        | `src/rag/`                                 | `createRetriever` runs k-NN (Bedrock Titan embeddings) + BM25 against a narrow `RetrievalBackend` port (null / pgvector / custom adapter), fused via Reciprocal Rank Fusion. `createGenerator` calls Claude Sonnet 4.6 via Bedrock with a strict system prompt over the verified-accessible documents                                                                                                                     |
| **audit**      | `src/audit/` + `src/bin/audit-consumer.ts` | `createAuditLogger` emits audit events to SQS (at-least-once → DLQ → `AuditTotalLoss` metric); `pii-scrubber.ts` redacts the org-wide union PII catalog (vendored `src/vendor/runtime/pii.ts`: secrets/tokens, SSN/cards, compensation, HR cases, health, DOB, contact info, AWS accounts, customer/infra identifiers) at the boundary. The consumer binary long-poll-drains SQS → DynamoDB (90d TTL) + S3 (1y lifecycle) |
| **ratelimit**  | `src/ratelimit/`                           | `createRateLimiter` is a Redis sliding-window limiter (per-user + per-workspace). Fail-open                                                                                                                                                                                                                                                                                                                               |

Cross-cutting: `src/vendor/runtime/` (modules vendored byte-identical from the nanohype `library/runtime` source of truth — the pure, timer-less circuit breaker the ACL guard and retriever share, the union PII catalog, and the WorkOS Directory client; synced/gated by `scripts/sync-vendored.mjs`), `src/metrics.ts` (OTel timing/counter surface), `src/context.ts` (OTel active-span wrapper), `src/config/` (Zod env validation, fail-fast at boot), `src/logger.ts` (Pino to stderr, OTel trace correlation).

## Key decisions

### Ports, not SDK patches

Every module that touches an external boundary exposes a `createXxx(deps)` factory accepting typed ports — `typeof fetch`, a narrow `RedisPort`, a `RetrievalBackend`, or an AWS SDK client. `src/index.ts` builds the concrete clients once and hands them in. Tests inject fakes implementing the port; **no test mocks an SDK package** (`vi.mock` of an SDK is grep-banned in CI), and AWS clients use `aws-sdk-client-mock` at the client level. The payoff is that swapping a backing service — Redis → Valkey, WorkOS → another directory, pgvector → OpenSearch/Qdrant/Pinecone, Bedrock → another LLM — is a one-file change to the bootstrap, not a refactor that ripples through call sites.

### ACL check runs after retrieval, against the asking user's own OAuth tokens

This is the property the whole product hangs on. Retrieval returns the documents that best match the query from a shared index. The ACL guard then re-verifies, **per document, against the asking user's own per-user OAuth token**, that the user can actually read it in the source system (a live Notion/Confluence/Drive API probe). A high-scoring document the user can't read is dropped. There is no shared service-account view of company knowledge — every query is bounded to exactly what that user could already see. Checking after retrieval (rather than filtering the index per-user) keeps a single index while still enforcing source-of-truth permissions at answer time, so a permission change in Notion is reflected on the next query with no re-index.

### Fail-secure ACL vs fail-open ratelimit

The two failure modes are deliberately opposite because the two checks protect different things. The **ACL guard fails secure**: a missing token, 403, 404, timeout, network error, or open circuit breaker all resolve to `wasRedacted: true` — the document leaves the result set. Wrongly hiding a document is recoverable; wrongly disclosing one is not. The **rate limiter fails open**: if Redis is unreachable, requests pass. The limiter's job is throttling, not authentication, so a Redis outage should degrade to "unthrottled," never to "service down." Each source also carries its own circuit breaker, so one flaky connector trips to redacted without dragging the others down.

### Per-user OAuth tokens in DynamoDB + KMS, not Secrets Manager

Each user delegates a per-source OAuth token, stored in DynamoDB with KMS envelope encryption (the `slack-knowledge-bot-oauth` `DDBKmsTokenStorage`). Secrets Manager would be the obvious home, but per-user secrets there cost on the order of ~$4k/month at 10k users versus ~$10/month for DDB + KMS at the same scale. App-level shared secrets (Slack/WorkOS/OAuth client credentials, DB creds) still live in Secrets Manager and reach the pod via the chart's `ExternalSecret`; only the high-cardinality per-user tokens go to DDB+KMS.

## Data flow: a single query

```
1.  Slack event (@mention or DM)            → Bolt handler (createQueryHandler)
2.  rate-limit (Redis sliding window)        → blocked? reply + stop (fail-open on Redis error)
3.  identity (Slack users.info → WorkOS Directory Sync, DDB-cached)
                                             → no directory match? reply + stop
4.  load per-user OAuth tokens (DDB + KMS)   → none present? Block Kit OAuth prompt + stop
5.  embed query (Bedrock Titan)
6.  hybrid search: k-NN + BM25 (pgvector / swappable backend) → RRF fusion
7.  per-user ACL verify (Notion/Confluence/Drive probes, fail-secure)
                                             → drop every doc the user can't read
8.  generate answer (Bedrock Claude Sonnet 4.6) over the verified-accessible docs
9.  format Block Kit reply with citations (URLs + last-modified; stale marker > STALE_DOC_THRESHOLD_DAYS)
10. audit event → SQS → (KEDA-scaled consumer) → DynamoDB (90d) + S3 (1y)
```

The generator handles empty context gracefully — if the retriever's breaker is open (returns empty hits) or every document is redacted, the bot says so rather than hallucinating. Token revocations from the `/slack-knowledge-bot disconnect` command flow through the OAuth port's revocation emitter into the same audit pipeline.

## What this repo deliberately does NOT do

- **Not its own cloud substrate.** It does not provision DynamoDB, Aurora, Redis, SQS, S3, or KMS. Those are landing-zone (see Boundaries). The chart consumes their outputs.
- **Not a model host.** Bedrock runs Claude and Titan inference outside the cluster on-account. No self-hosted models.
- **Not a cluster bootstrap.** The EKS cluster, ArgoCD, and the cluster addons it depends on (ESO, KEDA, cert-manager, external-dns, the AWS Load Balancer Controller, the observability stack) must already exist (eks-gitops).
- **Not the tenant operator.** It declares a `Platform` CR; the `eks-agent-platform` operator provisions the workload namespace, the tenant IAM role, and the AppProject.
- **Not an indexer.** This repo answers over an existing index; document ingestion/embedding into the retrieval backend is a separate concern.

## Boundaries

This repo owns the application — source, chart, Platform CR, gitops entry. Everything underneath it lives in two other repos.

### Substrate → `landing-zone`

`landing-zone/components/aws/tenant-substrate/` provisions the per-tenant AWS data plane and does not move here:

- 3 DynamoDB tables (token store, identity cache, audit log)
- Aurora Serverless v2 with pgvector (the retrieval backend)
- ElastiCache Redis (the rate limiter)
- SQS queue + DLQ (the audit pipeline)
- S3 audit bucket
- Secrets Manager seeding (`slack-knowledge-bot/<env>/*`), seeded out of band

All declared in `spec.datastores`. The dedicated KMS key for per-user OAuth token envelope encryption is app-specific substrate outside the datastore vocabulary — a deferred follow-up. The tenant IAM role is operator-generated: the app pods run as the operator-owned `tenant-runtime` ServiceAccount, bound to the role by a Pod Identity association the operator creates. The chart contains **no inline IAM**; the role and the association are operator-owned and consumed by reference.

### Cluster addons → `eks-gitops`

The chart assumes these cluster-level capabilities are already installed and reconciled by `eks-gitops`:

- **External Secrets Operator** — backs `externalsecret.yaml` (syncs `slack-knowledge-bot/<env>/app-secrets` + `db-credentials` from Secrets Manager)
- **KEDA** — backs `audit-consumer-scaledobject.yaml` (scales the audit consumer 0..5 on SQS queue depth)
- **the AWS Load Balancer Controller** — backs `ingress.yaml`. It creates the `alb` IngressClass this chart requests and provisions an internet-facing ALB registering pod IPs directly (Cilium runs ENI IPAM with native routing, so pod IPs are VPC addresses). TLS terminates on the load balancer against an ACM certificate — set `ingress.tls.certificateArn`, or leave it empty and let the controller match one to a rule host. There is no in-cluster certificate and no TLS Secret. The OAuth callback routes are public, so this is a prerequisite for the delegation flow, not a nicety
- **external-dns** — runs with `sources: [service, ingress]` and publishes the Route53 record for each `ingress.hosts[].host` from the Ingress itself, so the callback URL registered with each identity provider resolves
- **observability stack** — the cluster Grafana Alloy OTLP receiver (`alloy.monitoring.svc.cluster.local:4318`) and log forwarder that carry traces/metrics/logs to the Grafana backends. The app emits OTLP and structured JSON to stderr; there are no per-pod sidecars. The `grafana-dashboard.yaml` `GrafanaDashboard` CR loads into that stack via the grafana-operator. The `prometheusrule.yaml` alerts do not: they ship disabled because the stack runs no rule evaluator (gap G-01 in `docs/compliance-checklist.md`).
