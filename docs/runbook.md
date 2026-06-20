# SlackKnowledgeBot — Operator Runbook
**Version:** 1.0  
**Author:** tech-writer  
**Audience:** NanoCorp DevOps / Platform Engineering

---

## 1. Service Overview

| Property | Value |
|----------|-------|
| Service name | SlackKnowledgeBot |
| Purpose | Slack bot for NanoCorp knowledge retrieval |
| Slack handle | @slack-knowledge-bot |
| AWS account | NanoCorp Production |
| AWS region | us-west-2 |
| Deploy model | Platform tenant on the `eks-agent-platform` operator; ArgoCD reconciles `chart/` from git |
| EKS namespace | `tenants-protohype` |
| Workloads | main `Deployment` (Bolt + HTTP server) + KEDA-scaled audit-consumer `Deployment` |
| Container image | GHCR (`ghcr.io/nanohype/slack-knowledge-bot:<tag>`) |

---

## 2. Architecture Quick Reference

```
Slack → EKS pod (slack-knowledge-bot) → Aurora pgvector (search)
                              → DynamoDB (tokens, audit cache, identity)
                              → ElastiCache Redis (rate limiting)
                              → SQS → audit-consumer Deployment (KEDA) → DDB + S3 (audit log)
                              → Bedrock (LLM + embeddings)
                              → WorkOS Directory Sync (identity)
                              → Notion/Confluence/Drive APIs (connectors)
```

The app runs as two Deployments in namespace `tenants-protohype`: the main pod
(Bolt Socket Mode + the `node:http` server on :3001 serving `/health` and
`/oauth/:provider/{start,callback}`) and the audit-consumer (`node
dist/bin/audit-consumer.js`, KEDA-scaled 0..5 on SQS queue depth). Both share
one ServiceAccount whose `eks.amazonaws.com/role-arn` annotation points at the
landing-zone `slack-knowledge-bot-platform` IRSA role — pods
AssumeRoleWithWebIdentity into it on every AWS call.

---

## 3. Deployment

There is no in-repo IaC and no manual rollout. The app ships as a Platform
tenant of the `protohype` team on the `eks-agent-platform` operator, and ArgoCD
reconciles the Helm chart under `chart/` from git. CI builds + tests + scans the
image and publishes it to GHCR; ArgoCD picks up new tags and rolls the
Deployment. Operators touch git and `kubectl`, not the cluster's pods directly.

The infrastructure splits across three layers:

- **Substrate** — `landing-zone/components/aws/slack-knowledge-bot-platform/`
  (OpenTofu/Terragrunt) provisions DynamoDB ×3 (tokens, audit, identity-cache),
  SQS + DLQ, the S3 audit bucket, Aurora Serverless v2 (pgvector), ElastiCache
  Redis, the KMS token key, and seeds `slack-knowledge-bot/<env>/app-secrets`.
- **Platform CR** — `platform.yaml` declares slack-knowledge-bot as a tenant; the
  operator reconciles the namespace, ResourceQuota, LimitRange, default-deny
  NetworkPolicy, ArgoCD AppProject, the IRSA role, KMS grants, and the S3 bucket
  policy.
- **Chart** — `chart/` renders the two Deployments, Service, Ingress
  (ingress-nginx + cert-manager TLS), ExternalSecret, NetworkPolicy, the
  audit-consumer ScaledObject, PrometheusRule, and the Grafana dashboard.

### 3.1 First-Time Deploy

```bash
# 1. Substrate — apply the landing-zone slack-knowledge-bot-platform component
#    (DDB ×3, SQS + DLQ, S3 audit bucket, Aurora pgvector, ElastiCache Redis,
#    the KMS token key, and the seeded slack-knowledge-bot/<env>/app-secrets).
#    Its irsa_role_arn output drops into chart/values-<env>.yaml under
#    aws.platformRoleArn.

# 2. Seed the app-level secrets. Full operator guide (JSON shape, CLI commands,
#    where each value comes from, rotation) lives at docs/secrets.md. ESO syncs
#    slack-knowledge-bot/<env>/app-secrets + slack-knowledge-bot/<env>/db-credentials
#    from Secrets Manager into a k8s Secret. Tl;dr:
#      aws secretsmanager put-secret-value \
#        --secret-id slack-knowledge-bot/staging/app-secrets \
#        --secret-string file:///tmp/slack-knowledge-bot-staging-secrets.json

# 3. Platform CR — apply once during initial setup, then wait for Ready.
kubectl apply -f platform.yaml
kubectl wait --for=condition=Ready platform/slack-knowledge-bot --timeout=300s

# 4. GitOps — register gitops/applicationset-entry.yaml into nanohype/eks-gitops
#    (applicationsets/apps-tenants.yaml). ArgoCD renders the chart per cluster/env
#    and rolls out the main Deployment, the Ingress (ingress-nginx + cert-manager
#    TLS for /health + /oauth/:provider/{start,callback}), and the KEDA-scaled
#    audit-consumer Deployment.

# 5. Confirm the rollout (APP_BASE_URL is the cert-manager ingress hostname).
kubectl -n tenants-protohype rollout status deploy/slack-knowledge-bot
curl -fsS "https://$APP_BASE_URL/health"
```

### 3.2 Routine Deploys

Deploys flow through git + ArgoCD — there is no operator-run deploy script:

```
release workflow → build + test + scan → push ghcr.io/nanohype/slack-knowledge-bot:<tag>
                → bump the image tag in git → ArgoCD auto-syncs → Deployment rolls
```

Watch a sync land:

```bash
# ArgoCD app sync + health
argocd app get slack-knowledge-bot-<env>

# Or straight from the cluster
kubectl -n tenants-protohype rollout status deploy/slack-knowledge-bot
kubectl -n tenants-protohype get pods -l app.kubernetes.io/name=slack-knowledge-bot
```

### 3.3 CI

CI lives at the repo root: `.github/workflows/slack-knowledge-bot-ci.yml`. Triggers on push to `main` and on PRs touching `slack-knowledge-bot/**` or the workflow file. Steps (every gate must exit zero):

1. `actions/checkout@v4`
2. `actions/setup-node@v4`, node-version `24`, npm cache
3. `npm install --prefer-offline --no-audit --no-fund` (not `npm ci` — macOS-generated lockfile omits Linux platform-conditional binaries)
4. install + build `packages/oauth`
5. `npm run lint`
6. `npm run typecheck`
7. `npm run test`
8. `npm run build` (`tsc -p tsconfig.build.json` — emits `dist/`, excludes `*.test.ts`)
9. `npm run chart:lint` + `npm run chart:template:staging` (Helm chart renders cleanly)

CI carries no cluster or AWS credentials. The release workflow builds the image, scans it, and publishes to GHCR; ArgoCD does the rollout.

---

## 4. Configuration Reference

All configuration is via environment variables. The chart's Deployment sets the
plain values and pulls secrets from the ESO-synced k8s Secret (`app-secrets` +
`db-credentials`, synced from Secrets Manager by the External Secrets Operator).

| Variable | Description | Example |
|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Bot user OAuth token | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | Request signature verification | `abc123...` |
| `SLACK_APP_TOKEN` | Socket Mode token | `xapp-...` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `DYNAMODB_TABLE_TOKENS` | Token store table | `slack-knowledge-bot-production-tokens` |
| `DYNAMODB_TABLE_AUDIT` | Audit log table | `slack-knowledge-bot-production-audit` |
| `DYNAMODB_TABLE_IDENTITY_CACHE` | Identity cache | `slack-knowledge-bot-production-identity-cache` |
| `SQS_AUDIT_QUEUE_URL` | Audit event queue | `https://sqs...` |
| `SQS_AUDIT_DLQ_URL` | Audit DLQ | `https://sqs...` |
| `RETRIEVAL_BACKEND_URL` | Retrieval backend URL (optional; composed from `PG*` if blank) | `postgresql://…` |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | pgvector (Aurora) connection fields | host/port/db from chart values; `PGUSER`/`PGPASSWORD` from the ESO-synced `db-credentials` Secret |
| `KMS_KEY_ID` | Token store KMS key | `mrk-abc123...` |
| `REDIS_URL` | ElastiCache Redis URL | `rediss://xxx.cache.amazonaws.com:6379` |
| `WORKOS_API_KEY` | WorkOS Bearer API key | `sk_…` (Secrets Manager) |
| `WORKOS_DIRECTORY_ID` | WorkOS Directory Sync directory id | `directory_01…` (Secrets Manager — seeded alongside the API key) |
| `APP_BASE_URL` | OAuth redirect base URL | `https://slack-knowledge-bot.nanocorp.internal` |
| `RATE_LIMIT_USER_PER_HOUR` | Per-user query limit | `20` |
| `RATE_LIMIT_WORKSPACE_PER_HOUR` | Workspace query limit | `500` |
| `STALE_DOC_THRESHOLD_DAYS` | Staleness threshold | `90` |

---

## 5. Health Checks

```bash
# Pod + Deployment health
kubectl -n tenants-protohype get deploy,pods -l app.kubernetes.io/name=slack-knowledge-bot

# Application health endpoint (port-forward the main pod's :3001)
kubectl -n tenants-protohype port-forward deploy/slack-knowledge-bot 3001:3001 &
curl -fsS http://localhost:3001/health

# Audit-consumer health (also exposes /healthz, /readyz on its PORT, default 3001)
kubectl -n tenants-protohype get deploy/slack-knowledge-bot-audit-consumer
kubectl -n tenants-protohype logs deploy/slack-knowledge-bot-audit-consumer --tail=50

# Firing PrometheusRule alerts (query Grafana Cloud Mimir / Alertmanager)
#   ALERTS{namespace="tenants-protohype", alertstate="firing"}
```

---

## 6. Monitoring & Alerts

SlackKnowledgeBot's observability is cluster-level — no per-pod sidecars. The app
writes structured JSON to stderr → the cluster log forwarder → **Grafana Cloud
Loki**. OTLP traces + metrics export to
`otel-collector.observability.svc.cluster.local:4318` → the cluster OTel
Collector → **Grafana Cloud Tempo** (traces) + **Mimir** (metrics). Alerting is
the chart's `prometheusrule.yaml` (four alerts), evaluated against Mimir and
routed by the cluster's Alertmanager to PagerDuty / Slack / email.

### 6.1 App metrics → Grafana Cloud Mimir

Latencies (histograms), counters, and the `circuit_open_total{source}` gauge
live in Mimir. Query them in Grafana Cloud Explore or via the ops dashboard.

| Metric | Where | Alert target |
|--------|-------|-------------|
| `query_latency` histogram | Mimir | p95 > 5s for 15min (`QueryP95` alert — see below) |
| `llm_latency` histogram | Mimir | p95 > 25s |
| `retrieval_latency` histogram | Mimir | p95 > 2s |
| `embedding_latency` histogram | Mimir | p95 > 1s |
| `llm_error_total` counter | Mimir | rate > 1/min (`LLMError` alert) |
| `redaction_count` counter | Mimir | track per-source; sudden spike = source ACL regression |
| `circuit_open_total{source}` counter | Mimir | any non-zero value pages on-call |
| `rate_limit_hit_total{limit_type}` counter | Mimir | tracking, not alerting |

### 6.2 Logs → Grafana Cloud Loki

The app writes JSON to stderr; the cluster log forwarder picks it up off the pod
and ships it to Loki, tagged with the pod's `namespace`/`pod`/`container`
metadata. Per-record fields: `level`, `trace_id`, `span_id` (the Pino mixin
stamps the active-span IDs on every line). Jump from a trace in Tempo → the log
stream for that `trace_id` with one click.

Break-glass: if Grafana is showing silence, check the pod is actually logging
(`kubectl -n tenants-protohype logs deploy/slack-knowledge-bot --tail=50`) before
suspecting the cluster forwarder.

### 6.3 PrometheusRule alerts

The chart's `prometheusrule.yaml` ships four alerts, evaluated against Mimir and
routed by the cluster's Alertmanager. Subscribe PagerDuty, a Slack webhook, or an
email at the Alertmanager receiver.

| Alert | Source | Threshold | Notes |
|---|---|---|---|
| `AuditDlqDepth` | SQS audit DLQ `ApproximateNumberOfMessagesVisible` | ≥ 1 | Compliance — see RB-01 |
| `QueryP95` | `query_latency` p95 | > 5000ms for 3 × 5min | See RB-02 |
| `LLMError` | `llm_error_total` rate | ≥ 5 in 5min | Bedrock failure rate |
| `AuditTotalLoss` | `audit_total_loss_total` | ≥ 1 in 5min | Primary SQS + DLQ both failed — compliance-critical |

```bash
# Currently firing for this tenant (run against Grafana Cloud Mimir / Alertmanager)
#   ALERTS{namespace="tenants-protohype", alertstate="firing"}
# Routing/receivers live in the cluster Alertmanager config (eks-gitops), not this chart.
```

### 6.4 Traces → Grafana Cloud Tempo

OTel spans from `http`/`fetch`/`aws-sdk`/`pg`/`ioredis` are auto-instrumented
via `NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"`
(see `Dockerfile`). The active-span `trace_id` is stamped on every log line by
the Pino mixin in `src/logger.ts`, so a one-liner error in Loki can be pivoted
to the full trace in Tempo in one click.

### 6.5 Dashboards

The eight-panel ops dashboard ships with the chart as a ConfigMap
(`grafana-dashboard.yaml`, labeled `grafana_dashboard: "1"`, loading
`chart/dashboards/slack-knowledge-bot.json`) and is auto-discovered by the
cluster Grafana sidecar. Find it in **Grafana Cloud → Dashboards →
`slack-knowledge-bot`**, querying Mimir.

---

## 7. Runbooks by Scenario

### RB-01: Audit DLQ Has Messages

**Symptom:** PrometheusRule alert `AuditDlqDepth` fires  
**Impact:** Some query audit events may not have been persisted  
**Priority:** High (compliance requirement)

```bash
# 1. Check DLQ depth
aws sqs get-queue-attributes \
  --queue-url DLQ_URL \
  --attribute-names ApproximateNumberOfMessages

# 2. Inspect DLQ messages
aws sqs receive-message \
  --queue-url DLQ_URL \
  --max-number-of-messages 10

# 3. Check audit-consumer Deployment errors
kubectl -n tenants-protohype logs deploy/slack-knowledge-bot-audit-consumer \
  --since=1h | grep -i error
#    KEDA scales this Deployment 0..5 on the audit queue depth; if the main
#    queue is also backing up, confirm the consumer scaled up at all:
kubectl -n tenants-protohype get scaledobject,hpa -l app.kubernetes.io/name=slack-knowledge-bot

# 4. Common causes and fixes:
#    - DDB write throttle: Check DDB consumed capacity, scale if needed
#    - S3 write error: Check S3 bucket ACL/policy
#    - Consumer not scaling: check the KEDA aws-sqs-queue trigger + the pod IRSA

# 5. Replay DLQ messages (after fixing root cause)
aws sqs change-message-visibility-batch \
  --queue-url DLQ_URL \
  --entries '[{"Id":"1","ReceiptHandle":"...","VisibilityTimeout":0}]'

# Move messages back to main queue for reprocessing
# (Use the SQS DLQ redrive feature in AWS Console)
```

### RB-02: High Query Latency (p50 > 3s)

**Symptom:** `QueryP95` alert fires for query latency  
**Possible causes:** Bedrock throttling, pgvector slow queries, ACL check timeouts

```bash
# 1. Find slow queries in Loki (query via Grafana Cloud → Explore → Loki):
#    {service="slack-knowledge-bot", environment="production"} |= "query processed" | json | latencyMs > 3000
#    Then copy a `trace_id` and pivot to Tempo for the full span tree.

# 2. Compare query_latency histogram in Mimir against baseline:
#    histogram_quantile(0.95, sum by (le) (rate(query_latency_bucket[5m])))
#    vs. the same expression over 24h ago.

# 3. Bedrock latency: the auto-instrumented `aws-sdk` span group has the
#    InvocationLatency broken down per model in Tempo. Filter by
#    service.name=slack-knowledge-bot AND rpc.method=InvokeModel.

# 4. If Bedrock is the bottleneck:
#    - Check Bedrock service quotas (tokens per minute)
#    - Consider fallback to Claude 3 Haiku for simple queries
#    - Request quota increase via AWS Support

# 4. If ACL checks are the bottleneck:
#    - Check source system API latency (Notion/Confluence/Drive)
#    - Source system may be rate-limiting SlackKnowledgeBot's service account
```

### RB-03: ACL Check Error Rate > 1%

**Symptom:** redaction/circuit-breaker metrics spike for a source  
**Impact:** Possible conservative over-redaction (not under-redaction — fail-secure)

```bash
# Recent ACL-probe non-auth errors (Grafana Cloud → Explore → Loki):
#   {service="slack-knowledge-bot"} |= "ACL probe non-auth error"
# Redactions by source:
#   sum by (source) (rate(redaction_count_total[5m]))    # in Mimir

# Circuit-breaker trips (one trip = O(5) consecutive failures → fail-secure):
#   {service="slack-knowledge-bot"} |= "ACL probe short-circuited"
#   or: circuit_open_total{source="notion|confluence|drive"} in Mimir

# 401s typically mean user-specific token refresh — expected during
# extended user absence. Check getValidToken warnings:
#   {service="slack-knowledge-bot"} |= "getValidToken failed"
```

### RB-04: Pods Not Running

**Symptom:** ready replicas < desired for `deploy/slack-knowledge-bot` (or the audit-consumer)

```bash
# Why are the pods unhealthy? (events + crash reasons)
kubectl -n tenants-protohype describe deploy/slack-knowledge-bot
kubectl -n tenants-protohype get pods -l app.kubernetes.io/name=slack-knowledge-bot
kubectl -n tenants-protohype logs deploy/slack-knowledge-bot --previous --tail=100

# Common causes: ESO hasn't synced the Secret (bad/missing key → Zod exits 1),
# IRSA AssumeRole denied, or the image tag doesn't exist in GHCR.
kubectl -n tenants-protohype get externalsecret slack-knowledge-bot

# Restart the rollout (re-pulls the current tag, re-resolves the Secret)
kubectl -n tenants-protohype rollout restart deploy/slack-knowledge-bot

# Roll back to the last-known-good ReplicaSet
kubectl -n tenants-protohype rollout undo deploy/slack-knowledge-bot
# Or, for a durable rollback, pin the previous image tag in git and let ArgoCD
# reconcile (argocd app rollback slack-knowledge-bot-<env> works too).
```

### RB-05: Redis Cluster Unavailable

**Symptom:** Connection errors to Redis in the pod logs  
**Impact:** Rate limiter fails open (queries still served; rate limit not enforced)  
**This is the designed behavior** — rate limiting is a fairness control, not a security gate

```bash
# Check Redis cluster status
aws elasticache describe-replication-groups \
  --replication-group-id slack-knowledge-bot-production

# If the cluster is down, the pods log warnings but keep serving.
# Rate limiting is not enforced until Redis recovers.
kubectl -n tenants-protohype logs deploy/slack-knowledge-bot --tail=50 | grep -i redis

# For planned Redis maintenance: rate limiting is temporarily suspended
# Monitor for abnormal query volumes during Redis downtime
```

---

## 8. Connector Crawl Operations

```bash
# Last crawl time for each source (Grafana Cloud → Explore → Loki):
#   {service="slack-knowledge-bot"} |= "crawl complete"

# Force immediate re-crawl (e.g., after bulk doc updates)
# Send a message to the crawl trigger queue or restart the main Deployment
kubectl -n tenants-protohype rollout restart deploy/slack-knowledge-bot

# Check pgvector chunk count
psql "$RETRIEVAL_BACKEND_URL" -c "SELECT count(*) FROM chunks"
```

---

## 9. Security Incident Response

### If cross-space data leak is suspected:
1. Immediately disable @slack-knowledge-bot in Slack (revoke Bot Token in Slack app settings)
2. Page NanoCorp Security team
3. Export audit logs for the affected time window:
   ```bash
   aws dynamodb query \
     --table-name slack-knowledge-bot-production-audit \
     --key-condition-expression "userId = :uid" \
     --expression-attribute-values '{":uid":{"S":"AFFECTED_USER_ID"}}'
   ```
4. Identify all doc IDs returned to the affected user
5. Cross-reference against affected user's source-system access logs
6. Prepare incident report with: timeline, affected users, affected docs, root cause
7. Notify within 72 hours if GDPR applies

### If OAuth token exfiltration is suspected:
1. Rotate KMS key (new key version; all decryptions will fail → users re-auth)
2. Delete all token store entries:
   ```bash
   # Run a scan-and-delete (one-time, requires security team access)
   # This forces all users to re-authorize
   ```
3. Revoke OAuth app access in Notion/Confluence/Google Cloud console
4. Re-issue new OAuth app credentials

---

## 10. Backup & Recovery

| Data | Backup Method | RPO | RTO |
|------|--------------|-----|-----|
| DDB token store | PITR (prod) | 1s | <5min |
| DDB audit log | PITR (prod) | 1s | <5min |
| S3 audit bucket | S3 versioning | N/A (immutable) | Immediate |
| pgvector `chunks` | RDS automated backups + snapshots | 5 min (backup window) | ~15 min restore |
| Redis rate limits | None needed | N/A | Instant reset |

**pgvector rebuild procedure (full re-ingest):**
1. `TRUNCATE chunks` or drop/recreate via schema bootstrap
2. Re-run the ingestion pipeline against source documents
3. Embedding re-generation dominates runtime (Bedrock Titan throughput caps)
