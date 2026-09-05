# slack-knowledge-bot

Internal Slack knowledge bot — answers employee questions over Notion, Confluence, and Google Drive with per-user ACL enforcement.

> Internal service handle: `slack-knowledge-bot`. The npm package, the OTel `service.name` / `agents.platform`, the `/slack-knowledge-bot` slash command, and the `slack-knowledge-bot/<env>/*` secret prefixes all stay `slack-knowledge-bot` — they're coupled to the landing-zone `tenant-substrate` substrate component.

## What This Is

A nanohype composite, shipped as a standalone Platform tenant. Composes the `slack-bot`, `rag-pipeline`, and `module-vector-store` patterns into a working application. Employees @mention the bot or DM it; it answers grounded in their own access-controlled documents and cites every source.

**Built as a reusable subsystem.** Every external-IO service is a `createXxx(deps)` factory accepting typed ports (`typeof fetch`, a narrow `RedisPort`, a `RetrievalBackend`, or an AWS SDK client). `src/index.ts` is the single place real SDK clients are constructed; everything downstream runs against port interfaces, so swapping Redis → Valkey, WorkOS → Okta/Entra/Google Admin, pgvector → OpenSearch/Qdrant/Pinecone, or one model → another (a route edit on the `ModelGateway` CR) is a one-file change.

## How It Works

```
Slack event ─► rate-limit (Redis) ─► identity (Slack users.info → WorkOS Directory Sync)
                                            │
                                            ▼
                              load per-user OAuth tokens (DDB + KMS)
                                            │
                                            ▼
              embed query (gateway → Titan) ──► hybrid k-NN+BM25 search (pgvector / swappable)
                                            │
                                            ▼
           per-user ACL verify (Notion/Confluence/Drive) — fail-secure
                                            │
                                            ▼
           generate answer (gateway → Claude Sonnet 5) → Block Kit reply
                                            │
                                            ▼
                  audit event → SQS → audit-consumer (KEDA) → DDB+S3
```

Core insight: **the ACL check happens after retrieval, against the asking user's own OAuth tokens.** A document scoring high in the index is dropped if the user can't read it in the source system. There is no shared service-account view of company knowledge — every query is bounded to what that user could see anyway.

Every answer cites sources with URLs and last-modified timestamps. Documents older than `STALE_DOC_THRESHOLD_DAYS` (default 90) get a stale-warning marker.

## Architecture

Every module that touches an external boundary exposes a `createXxx(deps)` factory. Bootstrap in `src/index.ts` builds the SDK clients once and hands them in.

- **src/slack/** — `createQueryHandler(deps)` orchestrates the pipeline (rate → identity → token presence check → embed → search → ACL → generate → format → audit). `createDisconnectCommand(deps)` implements the `/slack-knowledge-bot disconnect [source|all]` slash command (user self-service revoke; revocations flow through the OAuth port → audit pipeline). `formatter.ts` builds Block Kit responses (answers, citations, OAuth prompts, rate-limit messages, error messages with trace IDs).
- **src/identity/** — `createWorkOSResolver({fetchImpl, ddbClient, workosApiKey, workosDirectoryId, ...})` maps Slack user → workforce-directory user via WorkOS Directory Sync, cached in DDB (1h TTL). The raw directory-API access (Bearer auth, `limit=100` cursor pagination, client-side email matching, bounded `maxPages`) is the vendored `src/vendor/runtime/workos-directory.ts` client; the resolver wraps the injected fetch with `AbortSignal.timeout` before handing it to the client's fetch port and owns the DDB cache + fail-soft (log + null) contract. Bearer-API-key auth means no service-token refresh, no L2 cache.
- **src/oauth/** — SlackKnowledgeBot's adoption of the `slack-knowledge-bot-oauth` package (scaffolded into `packages/oauth/` from the nanohype `module-oauth-delegation` template). `createSlackKnowledgeBotOAuth({auditLogger, ...})` builds the OAuth router with Notion/Atlassian/Google providers + DDB+KMS storage + a `RevocationEmitter` that lands in the audit pipeline. `url-token.ts` signs and verifies the short-lived OAuth `/start` URLs handed to users in Slack. `http.ts` bridges node:http ↔ Web-standard Request/Response so the module's framework-neutral handlers can live on SlackKnowledgeBot's existing HTTP server.
- **src/connectors/** — `createAclGuard({fetchImpl, onCounter})` verifies access per source (Notion/Confluence/Drive) using a `getAccessToken` callback (supplied by the query handler as `oauth.getValidToken`). Per-source probes live in `notion.ts`/`confluence.ts`/`drive.ts` behind a `ConnectorVerifier` registry; each probe receives the injected `fetchImpl` so tests pass `vi.fn<typeof fetch>()`. Every source gets its own circuit breaker (`failureThreshold: 5`, `windowMs: 60s`, `halfOpenAfterMs: 30s`); when a breaker trips we emit `slack_knowledge_bot_circuit_open_total{source}` once and short-circuit to `wasRedacted=true` until the cooldown elapses. Fail-secure: missing token, 403, 404, timeout, network error, or open breaker → `wasRedacted=true`.
- **src/rag/** — `createRetriever({backend, gatewayEndpoint, embeddingRoute, embeddingDimensions, onCounter})` runs k-NN (Titan embeddings through the gateway's embeddings route) + BM25 against a narrow `RetrievalBackend` port (null, pgvector, or a custom adapter) and fuses via Reciprocal Rank Fusion (`rrfFusion` is a pure export, covered directly). The retrieval backend (k-NN + BM25) is wrapped in one breaker (`source: "retrieval"`); when tripped we log a warn and return empty hits — the generator handles empty context gracefully. Embeddings (Bedrock Titan) are deliberately not on the same breaker (Bedrock has its own retry). `createGenerator({model, llmRoute, staleThresholdDays, ...})` calls Claude through the gateway with a strict system prompt and the verified-accessible documents.
- **src/audit/** — `createAuditLogger({sqs, queueUrl, dlqUrl, ...})` builds and emits audit events to SQS (at-least-once → DLQ → `AuditTotalLoss` metric). Discriminated `AuditEvent = QueryAuditEvent | RevocationAuditEvent` union. `buildQueryAuditEvent` is a pure helper, covered directly. `pii-scrubber.ts` is the scrubbing seam at the boundary; it applies the org-wide union PII catalog from the vendored `src/vendor/runtime/pii.ts` (secrets/tokens, SSN/cards, compensation, HR/HR-case, health, DOB, contact info, AWS accounts, customer/infrastructure ids). `audit-consumer.ts` is the SQS-drain side — long-poll receive, regex-validate, write to DynamoDB (90d TTL) + S3 (1y lifecycle), delete on success. Port-injected (SQSClient + DynamoDBClient + S3Client + queue URL + table/bucket names + shouldStop callback). Runs as the KEDA-scaled audit-consumer Deployment (see below).
- **src/bin/audit-consumer.ts** — Entry binary for the audit consumer Deployment. Constructs the SQS/DDB/S3 clients with explicit per-request timeouts via `NodeHttpHandler`, starts a tiny `node:http` health server on PORT (default 3001), and runs `runAuditConsumer` until SIGTERM. The chart's `audit-consumer-deployment.yaml` runs `node dist/bin/audit-consumer.js`; KEDA scales the Deployment on audit queue depth via `audit-consumer-scaledobject.yaml`.
- **src/ratelimit/** — `createRateLimiter({redis, userPerHour, workspacePerHour})` is a Redis sliding-window limiter (per-user + per-workspace). Multiple replicas require shared state; in-memory Maps would multiply the limit by replica count. Prune, count, decide and spend happen in one `EVAL` (`RATE_LIMIT_SCRIPT`) over both keys, so there is no instant at which a count has been read and not yet spent — a read followed by a write admits every concurrent request that observed the same under-limit count, and both keys share the script because two scripts would each be atomic while the pair was not. Fails open if Redis is unreachable or the reply is unreadable.
- **src/redis.ts** — Default ioredis client factory used by the bootstrap. Consumers receive the Redis port via `createXxx` factory deps, never via direct module import.
- **src/vendor/runtime/** — modules vendored **byte-identical** from the nanohype `library/runtime/` source of truth (the same vendor-and-sync contract as the `tenant-chart-base` chart under `chart/charts/`). Copies are byte-identical to nanohype at the commit pinned in `scripts/vendored.json`. Never edit these files here — fix upstream, then run `npm run sync:vendored -- --ref=<sha>`, which re-vendors and moves the pin together so the recorded commit and the bytes on disk cannot describe different things. CI runs `scripts/sync-vendored.mjs --check` against a nanohype checkout **at that pin**, so a merge in nanohype never turns this repo's required check red; `--freshness` asks whether the pin has fallen behind on a weekly schedule instead. Their unit tests live upstream; this repo covers them at its integration points. Vendored today: `circuit-breaker.ts` (`createCircuitBreaker({name, failureThreshold, windowMs, halfOpenAfterMs, onOpen, now?, reset()})` — the pure, timer-less sliding-window breaker used by the ACL guard (per source) and the retriever (one); `onOpen` fires exactly once per closed→open transition so callers can wire a `slack_knowledge_bot_circuit_open_total{source}` counter, `onClose` mirrors it on recovery, and all time reads go through the injected `now()` so tests tick a fake clock synchronously), `guardrails.ts` (prompt-assembly fencing for untrusted text — used by `src/rag/generator.ts` to fence retrieved document content before it reaches Bedrock; measured by `evals/`), `metrics.ts` (the lazy namespace-qualified OTel instrument core behind `src/metrics.ts`), `pii.ts` (the org-wide union redaction catalog behind `src/audit/pii-scrubber.ts`), and `workos-directory.ts` (the WorkOS Directory client behind `src/identity/workos-resolver.ts`). The files are Biome-excluded and coverage-excluded — byte-identity forbids local rewrites, and the upstream suite carries their unit coverage.
- **src/metrics.ts** — OTel metrics (`@opentelemetry/api`) behind a `timing` / `counter` / `flushMetrics` surface. `timing` → histogram (unit `ms`), `counter` → monotonic counter; both are exported OTLP by the auto-instrumentation runtime to the OpenTelemetry Collector gateway (`telemetry.monitoring.svc.cluster.local:4318`) → Amazon Managed Prometheus. `flushMetrics` is a no-op retained for shutdown-path symmetry.
- **src/context.ts** — `requestContext.run(_ctx, fn)` wraps `fn` in a `slack.query` OTel active span. The `traceId` field on the context argument is ignored (OTel owns trace IDs); callers that want a local UUID for user-facing error messages keep their own variable. No AsyncLocalStorage shim.
- **src/config/** — Zod schema validates every env var at startup; missing required keys fail-fast via `process.exit(1)`.
- **src/logger.ts** — Pino, JSON to stderr. The mixin pulls `trace_id` + `span_id` from the active OTel span on every log call, so any code running inside an auto-instrumented fetch/http/aws-sdk hop (or the outer `requestContext.run`) emits fields Grafana Tempo → Loki can jump between one-click.
- **src/index.ts** — Bootstrap. Builds every SDK client (Redis, SQS, DDB, Bedrock, retrieval backend, OAuth router) once, wires every `createXxx(deps)` factory, registers Bolt handlers (query + disconnect command), starts the `node:http` server on port 3001 serving `/health` (liveness — always OK so a bad token never crash-loops the pod), `/ready` (readiness — OK only once Bolt has started, flipped false at SIGTERM so the pod leaves Service rotation before the drain), and `/oauth/:provider/{start,callback}`. Graceful shutdown fails readiness, stops Bolt, drains in-flight queries, and flushes metrics on SIGTERM/SIGINT.
- **packages/oauth/** — The scaffolded `slack-knowledge-bot-oauth` package (module-oauth-delegation). Linked via `file:./packages/oauth` in SlackKnowledgeBot's `package.json`. Self-contained: its own `package.json`, `tsconfig.json`, `vitest.config.ts`, and test suite. Rebuild with `cd packages/oauth && npm run build`.
- **chart/** — Helm chart for the k8s deployment. `Chart.yaml`, `values.yaml`, per-env deltas (`values-{staging,production}.yaml`), and templates under `chart/templates/`: `deployment.yaml` (main pod), `service.yaml` (ClusterIP :3001), `ingress.yaml` (`/health` and `/oauth/:provider/{start,callback}` on the `alb` class the eks-gitops load balancer controller serves; TLS terminates on the ALB against an ACM certificate), `serviceaccount.yaml` (the operator-owned `tenant-runtime` SA, bound to the operator-minted `<env>-slack-knowledge-bot-tenant` IAM role by an EKS Pod Identity association the operator creates — no role-arn annotation), `externalsecret.yaml` (External Secrets Operator syncs `slack-knowledge-bot/<env>/app-secrets` + `slack-knowledge-bot/<env>/db-credentials` from AWS Secrets Manager into a k8s Secret), `networkpolicy.yaml` (default-deny + egress allow-list for AWS APIs, Slack/WorkOS/Notion/Confluence/Drive HTTPS, RDS+Redis on the cluster VPC CIDR), `audit-consumer-deployment.yaml` + `audit-consumer-scaledobject.yaml` (audit-consumer Deployment running `dist/bin/audit-consumer.js`, KEDA-scaled 0..5 replicas on SQS audit queue depth via `aws-sqs-queue` trigger using the pod's IAM identity), `prometheusrule.yaml` (QueryP95, LLMError, AuditTotalLoss; the AuditDlq-depth alert is opt-in behind `auditDlq.cloudwatchExporterEnabled`), `grafana-dashboard.yaml` (a `GrafanaDashboard` CR reconciled by the grafana-operator onto Amazon Managed Grafana, loading the dashboard from `chart/dashboards/slack-knowledge-bot.json`). Observability is cluster-level via eks-gitops: app writes structured JSON to stderr → cluster log forwarder → Loki; OTLP traces + metrics export to `telemetry.monitoring.svc.cluster.local:4318` → the OpenTelemetry Collector → Tempo + Amazon Managed Prometheus. No per-pod sidecars. See `chart/README.md` for the full template-by-template description and where the substrate + cluster addons sit.
- **platform.yaml** — the cluster-scoped `Tenant` CR for the `workplace` team, plus the Platform CR (`platform.nanohype.dev/v1alpha1`) and its co-declared BudgetPolicy (`governance.nanohype.dev/v1alpha1`) declaring slack-knowledge-bot as a tenant of that team on the `eks-agent-platform` operator. The Platform + BudgetPolicy are applied into `tenants-workplace`, the team's CR-home namespace; the Tenant is cluster-scoped and takes no namespace. The operator provisions the workload namespace `tenants-slack-knowledge-bot` (derived from `Platform.metadata.name`), ResourceQuota, LimitRange, default-deny NetworkPolicy, ArgoCD AppProject, and the `<env>-slack-knowledge-bot-tenant` IAM role — Bedrock invoke clamped to `spec.identity.allowedModels`, substrate grants attached from `spec.identity.extraPolicyArns`. Apply once during initial setup; the chart's ApplicationSet entry takes over after the Platform reaches `Ready`. `npm run platform:validate` is the gate over this file — see `schemas/crd/` below.
- **schemas/crd/** — the eks-agent-platform CRD schemas (`Tenant`, `Platform`, `BudgetPolicy`), vendored from `nanohype/eks-agent-platform`'s `operators/config/crd/bases/` with the upstream repo, path, pinned commit, and a SHA-256 per file recorded in `schemas/crd/source.json`. `scripts/validate-platform-manifests.mjs` reads them off disk and verifies those digests before validating anything — no network, no sibling checkout, and a missing or hand-edited schema aborts the run rather than passing vacuously. The walker rejects unknown properties as well as missing required ones, because `controller-gen` omits `additionalProperties: false` and a stock JSON-Schema validator would accept an invented field that Kubernetes then prunes silently. It also asserts scope (`Tenant` cluster-scoped, the other two namespaced) from each CRD's own `spec.scope`, and the cross-references: `Platform.spec.tenant` → the declared `Tenant`, `Platform.spec.budget.name` → the `BudgetPolicy`, and `agents.tenant` / `agents.platform` in every `chart/values*.yaml` → both. `--self-test` breaks the manifest in memory four ways, tampers with a vendored schema, and fails unless every one is rejected; CI runs it alongside the real validation. Pin fidelity is the other half: `npm run schemas:check` (CI job `crd-schema-drift`) compares the vendored copies byte-for-byte against upstream at the pinned ref, so a hand-moved pin does not survive. Whether the pin has fallen behind upstream is asked by `npm run schemas:freshness` on a weekly schedule, off the blocking path — a required check must not flip red because another repo moved. Re-vendor with `npm run schemas:sync -- --ref=latest` when the operator's API types change (a full 40-character SHA works too, for a specific commit). `latest` resolves the newest commit touching the vendored path at the moment the re-vendor runs, and is what the freshness report names: that report is copied verbatim into an issue body re-edited weekly and read on whatever day someone opens it, so a resolved commit printed there would be the newest thing upstream for at most a week while being presented as current for as long as the issue stayed open. `npm run schemas:freshness:test` (CI job `verify`, and part of `npm run check`) runs the report against a fixture upstream repository and asserts on its emitted bytes — exit 2, no commit the fixture built appearing at seven characters or more and no hex run of seven or more carrying a digit whatever commit it belongs to, a remediation naming the command with no placeholder beside it, and that command landing the pin on the fixture's newest commit touching the vendored path. It drives both seams, the checkout and GitHub through a fetch stub serving the same fixture, because the scheduled workflow reads only the second; it asserts that a shallow clone and a clone not descending from the pin are refused rather than answered from, that a schema removed upstream reports as drift rather than as an unreachable upstream, and it reads the scheduled workflow's own remediation block, which reaches the same reader and no assertion on the script can see. `npm run schemas:freshness:selftest` removes that fix every way it can come back and fails unless the assertion named for each break is what catches it. See `schemas/crd/README.md`.
- **gitops/applicationset-entry.yaml** — ApplicationSet entry to register into `nanohype/eks-gitops` (`applicationsets/apps-tenants.yaml`). Matrix generator over `clusters × [slack-knowledge-bot]` so the same entry deploys to every cluster labeled with the right environment. Helm multi-source pattern: `$values` reference resolves to `values.yaml` + `values-{env}.yaml`.

## Commands

```bash
npm run dev            # Start service via tsx watch (src/index.ts)
npm run build          # tsc -p tsconfig.build.json — emits dist/, excludes *.test.ts
npm start              # Run compiled output (dist/index.js)
npm test               # vitest run (unit + the offline eval tier)
npm run eval           # the model tier — needs EVAL_LLM (see evals/README.md)
npm run test:redis     # the live-Redis tier — runs the limiter's Lua in a real server
npm run test:coverage  # vitest run --coverage (v8 provider)
npm run test:watch     # interactive vitest watch mode
npm run lint           # biome lint .
npm run format         # biome format --write .
npm run format:check   # biome format .
npm run typecheck      # tsc --noEmit
npm run check          # typecheck + lint + format:check + test + platform:validate + schemas:freshness:{test,selftest}
npm run platform:validate    # validate platform.yaml against the vendored CRD schemas, then self-test the gate
npm run schemas:sync         # re-vendor schemas/crd/ from eks-agent-platform, rewrite the pin + digests
npm run schemas:sync -- --ref=latest  # adopt the newest operator API: resolve upstream, re-vendor, move the pin
npm run schemas:check        # blocking gate — digests verified, and bytes matched against upstream at the pinned ref
npm run schemas:freshness    # scheduled-only: has the pin fallen behind upstream? never a merge gate
npm run schemas:freshness:test  # blocking gate — that report names a command, not a run-time commit
npm run sync:vendored        # re-vendor runtime, config + chart base from nanohype at the pinned commit
npm run sync:vendored -- --ref=<sha>  # adopt a newer library: re-vendor and move the pin together
npm run sync:vendored:check  # blocking gate — vendored bytes == nanohype at the pinned commit
npm run sync:vendored:freshness  # scheduled-only: has the pin fallen behind upstream? never a merge gate
npm run sync:vendored:selftest   # break the gate's inputs 17 ways; fail unless every break is rejected
npm run audit:prod     # npm audit --audit-level=high --omit=dev
npm run build:oauth    # build the slack-knowledge-bot-oauth package (packages/oauth)
```

Chart (Helm):

```bash
npm run chart:lint              # helm lint chart
npm run chart:template:staging  # helm template against values-staging.yaml
```

## Deploy

The app ships as a Platform tenant of the `workplace` team on the `eks-agent-platform` operator. There is no in-repo IaC and no manual rollout — ArgoCD reconciles the chart from git.

1. **Substrate** — the Aurora pgvector store, three DynamoDB tables, the Redis cache, the S3 audit bucket, and the FIFO audit queue are declared in `spec.datastores` and provisioned by the generic `landing-zone` `tenant-substrate` component. The operator generates the datastore-access policy and creates the Pod Identity association binding the operator-owned `tenant-runtime` ServiceAccount to the `<env>-slack-knowledge-bot-tenant` role. App secrets are seeded to `slack-knowledge-bot/<env>/app-secrets` out of band (`docs/secrets.md`). The KMS token-envelope key needs no declaration: `tenant-substrate` mints one customer-managed key per tenant unconditionally, and the operator grants GenerateDataKey/Decrypt/DescribeKey on it through the `tenant-key-access` policy — envelope encryption is independent of the datastore vocabulary.
2. **Platform CR** — `kubectl apply -f platform.yaml` once during initial setup. The operator provisions Namespace `tenants-slack-knowledge-bot`, ResourceQuota, LimitRange, default-deny NetworkPolicy, the ArgoCD AppProject, and the `<env>-slack-knowledge-bot-tenant` IAM role. Wait for the Platform to reach `Ready`.
3. **GitOps** — `gitops/applicationset-entry.yaml` is registered in `nanohype/eks-gitops`. ArgoCD renders the chart per cluster/env and rolls out the main `Deployment`, the `ingress` (ALB, ACM TLS, for `/health` + `/oauth/:provider/{start,callback}`), and the KEDA-scaled audit-consumer `Deployment`. New image tags flow through the release workflow → GHCR → ArgoCD picks up the bump.

`APP_BASE_URL` is the ingress hostname for the env, served by the ALB against an ACM certificate. The chart carries no role ARN — the operator binds the tenant-runtime ServiceAccount to the `<env>-slack-knowledge-bot-tenant` role, and EKS injects credentials through the standard AWS credential chain.

## Configuration

All config via env vars, validated by Zod in `src/config/index.ts`. Copy `.env.example` to `.env` and fill in. Required (no defaults):

- **Slack**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`
- **AWS**: `AWS_REGION`, `DYNAMODB_TABLE_TOKENS`, `DYNAMODB_TABLE_AUDIT`, `DYNAMODB_TABLE_IDENTITY_CACHE`, `SQS_AUDIT_QUEUE_URL`, `SQS_AUDIT_DLQ_URL`, `KMS_KEY_ID`, `REDIS_URL`. `AWS_REGION` is required rather than defaulted — it is what resolves every resource name above, so a default would guess a partition rather than fill a blank; the chart supplies it (`us-east-1` on this estate). AMP/Tempo/Loki are reached via the OpenTelemetry Collector receiver in the cluster (eks-gitops), which holds its own Pod Identity association — the app pods carry no observability-backend credentials — see `docs/secrets.md`.
- **WorkOS**: `WORKOS_API_KEY`, `WORKOS_DIRECTORY_ID`
- **OAuth apps** (per source): `NOTION_OAUTH_*`, `CONFLUENCE_OAUTH_*`, `GOOGLE_OAUTH_*`
- **OAuth delegation**: `STATE_SIGNING_SECRET` (≥ 32 bytes — HMACs both the module's state cookie and SlackKnowledgeBot's signed `/start` URL tokens)
- **App**: `APP_BASE_URL`

Defaults: `ORG_DISPLAY_NAME=your organization` (the name in the Block Kit footer — display only, so it is defaulted rather than required), `MODEL_ROUTE=default`, `EMBEDDING_ROUTE=embeddings` (route names on the Platform's ModelGateway, not model ids — the CR maps them to `us.anthropic.claude-sonnet-5` and `amazon.titan-embed-text-v2:0`), `RATE_LIMIT_USER_PER_HOUR=20`, `RATE_LIMIT_WORKSPACE_PER_HOUR=500`, `STALE_DOC_THRESHOLD_DAYS=90`, `TOKEN_STORE_ENCRYPTION_CONTEXT=slack-knowledge-bot-token-store`, `PG_SSL_REJECT_UNAUTHORIZED=true` (verifies the Aurora cert against the bundled RDS global CA at `certs/rds-global-bundle.pem`; set `false` for a chain-less local Postgres), `PG_SSL_CA_PATH=certs/rds-global-bundle.pem`, `NODE_ENV=development`.

App-level secrets in deployment live in AWS Secrets Manager at `slack-knowledge-bot/{env}/app-secrets`. Per-user OAuth tokens live in DynamoDB with KMS envelope encryption — NOT in Secrets Manager (per-user secrets would cost ~$4k/month at 10k users vs ~$10/month for DDB+KMS).

**Seeding / rotating the secret:** shape, CLI, and per-key provenance in [`docs/secrets.md`](docs/secrets.md).

## Conventions

- TypeScript strict, ESM NodeNext, Node ≥ 24 (Active LTS). Docker base image `node:24-alpine`, CI runs Node 24.
- Zod for all input validation (config, Slack event payloads at the boundary, third-party API responses).
- Structured JSON logging to stderr via Pino (`src/logger.ts`) — stdout reserved for CLI output.
- Logs / metrics / traces correlate via OTel `trace_id`; the logger pulls from the active span automatically (no ALS). App stderr → cluster log forwarder → Loki; OTLP → OpenTelemetry Collector gateway → Tempo (traces) + Amazon Managed Prometheus (metrics).
- Vitest for tests with `globals: true`. `src/test-setup.ts` seeds env vars so the config Zod parse succeeds in the runner.
- Biome (`biome.json`, extends the vendored org base) for lint + format — `format:check` is part of CI.
- Biome owns TS and JSON, so the four rules `.editorconfig` declares for *every* file — charset, LF endings, a final newline, no trailing whitespace — are unobserved across YAML, Markdown, shell and chart templates unless something reads the whole tree. The `nanohype/.github` `editorconfig-gate` action does, in the `verify` job, over every file `git ls-files` names. It has no local counterpart and `npm run check` does not carry it: the action reads the tree and opens no socket, which is what keeps a merge from waiting on a third party, and a second copy of that reading here is a copy nothing keeps honest. An editor applies the same four rules from `.editorconfig` on save.
- Explicit timeouts on every external call (`AbortSignal.timeout` on fetch and Bedrock, `NodeHttpHandler` `requestTimeout`/`connectionTimeout` on AWS SDK clients, ioredis `connectTimeout`/`commandTimeout`).
- **Ports, not SDK patches.** Every cross-boundary service is a `createXxx(deps)` factory accepting typed ports. Tests inject fakes implementing the typed port. **Never `vi.mock(<sdk-package>)`** — the rule is grep-enforced in CI.
- Fail-secure as the default failure mode for ACL checks: missing token, error, timeout → the document is dropped from results.
- Fail-open as the default for the rate limiter: Redis errors do not block users (the limiter's job is throttling, not authentication).

## Testing

Tests are colocated as `src/**/*.test.ts`. Run with `npm test` (also picks up `evals/**/*.test.ts` — fixture validity and the graders). The model tier is `npm run eval` against `evals/**/*.eval.ts` and is a separate CI job. Threshold-enforced coverage: 75 / 60 / 75 / 75 (statements / branches / functions / lines). Excludes `src/index.ts` (bootstrap, only verifiable in real-Slack integration), `src/connectors/types.ts` (type-only), `src/test-setup.ts`, `src/vendor/**`, and `*.test.ts` files themselves.

Service-wrapper tests (boundary services, port-injected fakes):

- `src/ratelimit/redis-limiter.test.ts` — fake `RateLimiterRedisPort`; under/blocked/fail-open
- `src/identity/workos-resolver.test.ts` — fake fetch + DDB mock; cache hit/miss, directory-filter shape, primary-email selection, multi-page cursor pagination
- `src/connectors/acl-guard.test.ts` — fake fetch; 200 grants, 403/404 redact, missing token, network error, per-source routing, circuit-breaker trip
- `src/rag/retriever.test.ts` — fake `RetrievalBackend` + Bedrock mock; pure `rrfFusion` ranking, dedup, topK, circuit-breaker trip → empty hits
- `src/rag/generator.test.ts` — Bedrock mock; zero-hits vs everything-redacted, stale citations, dedup, Bedrock failure
- `src/audit/audit-logger.test.ts` — SQS mock; primary → DLQ → total-loss fallover, pure `buildQueryAuditEvent`
- `src/metrics.test.ts` — smoke test for the OTel no-op surface (`timing`, `counter`, `flushMetrics` must not throw without a registered provider)

The vendored `src/vendor/runtime/` modules carry their unit suites upstream in nanohype `library/runtime/src/*.test.ts` (breaker state machine, PII pattern catalog, directory-client pagination); this repo asserts they are wired correctly at its integration points (acl-guard + retriever breaker trips, scrubber union behavior, resolver cache + lookup) instead of duplicating them.

Pure-logic tests (no I/O):

- `src/audit/pii-scrubber.test.ts` — the boundary contract over the vendored union catalog: every original category still redacts + the union-added categories (compensation, HR, health, DOB, customer/infra) redact, with false-positive guards
- `src/slack/formatter.test.ts` — citations fresh/stale/redacted, footer
- `src/oauth/url-token.test.ts` — signed `/start` URL round-trip, cross-provider replay, expiry

Slash-command + integration:

- `src/slack/disconnect-command.test.ts` — ack + users.info + revoke; all source/subcommand branches
- `src/slack/query-handler.integration.test.ts` — wires the real `createXxx` factories with stubbed boundaries; 6 scenarios (happy path, rate-limit blocked, missing email, identity fail, all-tokens-missing OAuth prompt, ACL redaction)

When adding tests: accept the SDK client as a typed dep on the source-side factory and inject a fake. **Do not `vi.mock(<sdk-package>)`** — that bans is rubric-enforced. AWS SDK clients use `aws-sdk-client-mock` (client-level injection, not module-level).

## Dependencies

- **`@anthropic-ai/sdk`** — the Messages client, pointed at the Platform's ModelGateway. Claude and Titan both run on Bedrock behind it; the app holds no model credential, and no source content reaches a third party
- **`@aws-sdk/client-dynamodb`** — token store, identity cache, audit log
- **`@opentelemetry/api`** + **`@opentelemetry/auto-instrumentations-node`** — OTel traces/metrics (histograms + counters); the `--require` hook in the Dockerfile auto-instruments http/fetch/aws-sdk/pg before user code
- **`@aws-sdk/client-kms`** — token envelope encryption
- **`@aws-sdk/client-sqs`** — audit event queue (at-least-once + DLQ)
- **`pg`** — pgvector retrieval backend (RDS Postgres)
- **`@slack/bolt`** — Slack app framework, Socket Mode
- **`@smithy/node-http-handler`** — explicit AWS SDK timeouts
- **`slack-knowledge-bot-oauth`** — local `file:` link to `packages/oauth/`; the OAuth-delegation module
- **`ioredis`** — sliding-window rate limiter
- **`pino`** — structured logging to stderr
- **`zod`** — env validation, runtime contracts at boundaries

The HTTP boundary uses native `fetch` (Node 24's WHATWG implementation) for Notion / Confluence / Drive ACL probes and for WorkOS Directory Sync — no axios.

That last clause holds of the installed tree, not just of first-party code, and it rests on two edges rather than one. `@slack/bolt` 5 declares no axios, *and* it pins `@slack/web-api ^8.0.0`, which dropped axios of its own accord — web-api 7 declared `axios ^1.11.0`, which is how axios was present under bolt 4 despite this rule. The web-api pin is the load-bearing half: a future bolt that relaxed it back to `^7` would put axios back in the tree while this line still claimed otherwise. If axios reappears, check that pin first.

## Reference docs (`docs/`)

- [`docs/prd.md`](docs/prd.md) — product requirements, OKRs, launch gates
- [`docs/rag-architecture.md`](docs/rag-architecture.md) — RAG system design
- [`docs/qa-playbook.md`](docs/qa-playbook.md) — end-to-end operator walkthrough: fresh deploy → first grounded Claude answer in Slack (+ gotcha-indexed troubleshooting appendix)
- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE threat model + red-team test cases
- [`docs/compliance-checklist.md`](docs/compliance-checklist.md) — SOC 2 / GDPR controls
- [`docs/runbook.md`](docs/runbook.md) — operator runbook (incident response)
- [`docs/integrations.md`](docs/integrations.md) — every third-party integration: port, setup, env vars, verify command
- [`docs/secrets.md`](docs/secrets.md) — Secrets Manager payload shape + seed/rotate CLI
- [`docs/onboarding.md`](docs/onboarding.md) — employee onboarding playbook (end-user facing, not operator)
- [`docs/test-plan.md`](docs/test-plan.md) — full test plan
