# Almanac — Operator Runbook
**Version:** 1.0  
**Author:** tech-writer  
**Audience:** NanoCorp DevOps / Platform Engineering

---

## 1. Service Overview

| Property | Value |
|----------|-------|
| Service name | Almanac |
| Purpose | Slack bot for NanoCorp knowledge retrieval |
| Slack handle | @almanac |
| AWS account | NanoCorp Production |
| AWS region | us-west-2 |
| ECS cluster | almanac-production |
| ECS service | almanac-production |
| ECR repo | almanac-production |

---

## 2. Architecture Quick Reference

```
Slack → ECS Fargate (almanac) → RDS Postgres pgvector (search)
                              → DynamoDB (tokens, audit cache, identity)
                              → ElastiCache Redis (rate limiting)
                              → SQS → Lambda → DDB + S3 (audit log)
                              → Bedrock (LLM + embeddings)
                              → WorkOS Directory Sync (identity)
                              → Notion/Confluence/Drive APIs (connectors)
```

---

## 3. Deployment

Deploys are operator-local from a workstation (or a release runner) with AWS credentials, Docker, and `aws` + `curl` on PATH. CI is local-check-only — it does not push to AWS. The deploy pipeline is one npm script: install → build oauth package → typecheck → lint → format-check → test → npm audit → `cdk deploy` (which builds the Docker image as a CDK asset, publishes to the bootstrap asset repo, and rolls the ECS service via task-def digest change) → post-deploy smoke against the live ALB.

### 3.1 First-Time Deploy

```bash
# 1. Bootstrap CDK (one-time per account/region)
cd almanac/infra && npm install
npx cdk bootstrap aws://ACCOUNT_ID/us-west-2
cd ..

# 2. Seed Secrets Manager with the app-level secrets.
#    Full operator guide (JSON shape, CLI commands, where each value
#    comes from, rotation) lives at docs/secrets.md.
#    Tl;dr:
#      aws secretsmanager put-secret-value \
#        --secret-id almanac/staging/app-secrets \
#        --secret-string file:///tmp/almanac-staging-secrets.json

# 3. (For real OAuth) pick one HTTPS shape — providers reject non-HTTPS callbacks.
#    Preferred: CDK-managed cert + Route 53 alias (zero post-deploy clicks).
export ALMANAC_STAGING_DOMAIN=almanac-staging.example.com
export ALMANAC_STAGING_HOSTED_ZONE_ID=Z01234ABCDEF
#    Or BYO cert ARN (escape hatch when ACM is owned by a separate team):
#    export ALMANAC_STAGING_CERT_ARN=arn:aws:acm:us-west-2:...:certificate/...

# 4. Deploy staging
npm run deploy:staging
# install:all → build:oauth → check → audit:prod → cdk deploy AlmanacStaging → smoke:staging
# Smoke reads ServiceUrl from CFN, waits for ECS steady state, curls /health,
# verifies /oauth/notion/start returns non-5xx.

# 5. Deploy production after staging passes
export ALMANAC_PRODUCTION_DOMAIN=almanac.example.com
export ALMANAC_PRODUCTION_HOSTED_ZONE_ID=Z01234ABCDEF
npm run deploy:production
```

### 3.2 Routine Deploys

Same one-shot npm script — re-run any time:

```bash
# Always export the HTTPS env vars before deploy (CDK branches on them
# to decide between HTTPS+cert and HTTP-only-smoke ALB listeners; an
# accidentally-empty deploy into a stack that previously had HTTPS
# enabled trips a listener-port collision — see docs/qa-playbook.md B.1).
export ALMANAC_STAGING_DOMAIN=almanac.example.com
export ALMANAC_STAGING_HOSTED_ZONE_ID=Z01234…

npm run deploy:staging        # or deploy:production
```

CDK uses `ecs.ContainerImage.fromAsset("..")`, so each deploy produces a new image digest → the task definition references that digest → ECS rolls automatically. There is no separate `docker push` or `aws ecs update-service --force-new-deployment` step.

The smoke step (`scripts/smoke.sh`) is also standalone and idempotent:

```bash
npm run smoke:staging         # safe to re-run against an already-deployed stack
npm run smoke:production
```

### 3.3 CI

CI lives at the repo root: `.github/workflows/almanac-ci.yml`. Triggers on push to `main` and on PRs touching `almanac/**` or the workflow file. Steps (every gate must exit zero):

1. `actions/checkout@v4`
2. `actions/setup-node@v4`, node-version `24`, npm cache
3. `npm install --prefer-offline --no-audit --no-fund` (not `npm ci` — macOS-generated lockfile omits Linux platform-conditional binaries)
4. install + build `packages/oauth`
5. `npm run lint`
6. `npm run typecheck`
7. `npm run test`
8. `npm run build` (`tsc -p tsconfig.build.json` — emits `dist/`, excludes `*.test.ts`)
9. install + `cdk synth AlmanacStaging` under `almanac/infra/`

CI carries no AWS credentials. Production cuts run from an operator workstation or a release runner, gated by the smoke step embedded in `npm run deploy:production`.

---

## 4. Configuration Reference

All configuration is via environment variables (injected from ECS task definition + Secrets Manager).

| Variable | Description | Example |
|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Bot user OAuth token | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | Request signature verification | `abc123...` |
| `SLACK_APP_TOKEN` | Socket Mode token | `xapp-...` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `DYNAMODB_TABLE_TOKENS` | Token store table | `almanac-tokens-production` |
| `DYNAMODB_TABLE_AUDIT` | Audit log table | `almanac-audit-production` |
| `DYNAMODB_TABLE_IDENTITY_CACHE` | Identity cache | `almanac-identity-cache-production` |
| `SQS_AUDIT_QUEUE_URL` | Audit event queue | `https://sqs...` |
| `SQS_AUDIT_DLQ_URL` | Audit DLQ | `https://sqs...` |
| `RETRIEVAL_BACKEND_URL` | Retrieval backend URL (optional; composed from `PG*` if blank) | `postgresql://…` |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | pgvector connection fields from RDS + Secrets Manager | (CDK-injected) |
| `KMS_KEY_ID` | Token store KMS key | `mrk-abc123...` |
| `REDIS_URL` | ElastiCache Redis URL | `rediss://xxx.cache.amazonaws.com:6379` |
| `WORKOS_API_KEY` | WorkOS Bearer API key | `sk_…` (Secrets Manager) |
| `WORKOS_DIRECTORY_ID` | WorkOS Directory Sync directory id | `directory_01…` (Secrets Manager — seeded alongside the API key) |
| `APP_BASE_URL` | OAuth redirect base URL | `https://almanac.nanocorp.internal` |
| `RATE_LIMIT_USER_PER_HOUR` | Per-user query limit | `20` |
| `RATE_LIMIT_WORKSPACE_PER_HOUR` | Workspace query limit | `500` |
| `STALE_DOC_THRESHOLD_DAYS` | Staleness threshold | `90` |

---

## 5. Health Checks

```bash
# ECS service health
aws ecs describe-services \
  --cluster almanac-production \
  --services almanac-production \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}'

# Application health endpoint (from within VPC)
curl http://TASK_IP:3001/health

# CloudWatch alarms
aws cloudwatch describe-alarms \
  --alarm-name-prefix "AlmanacProduction" \
  --state-value ALARM
```

---

## 6. Monitoring & Alerts

Almanac's observability stack is OTel-first — app logs go to **Grafana Cloud
Loki** (via the Fluent Bit FireLens sidecar), traces + metrics go to **Grafana
Cloud Tempo + Mimir** (via the ADOT collector sidecar, OTLP on `localhost:4318`).
CloudWatch is still the alarm backplane for infrastructure-level signals
(SQS DLQ depth, ECS service health) and the four app-level metrics the
`src/metrics.ts` emitter still publishes to the `Almanac` namespace; every
alarm fans out through a single SNS topic (`AlarmTopicArn` stack output) to
PagerDuty / Slack / email.

### 6.1 App metrics → Grafana Cloud Mimir

Latencies (histograms), counters, and the `circuit_open_total{source}` gauge
live in Mimir. Query them in Grafana Cloud Explore or via the ops dashboard.

| Metric | Where | Alert target |
|--------|-------|-------------|
| `query_latency` histogram | Mimir | p95 > 5s for 15min (also a CloudWatch alarm — see below) |
| `llm_latency` histogram | Mimir | p95 > 25s |
| `retrieval_latency` histogram | Mimir | p95 > 2s |
| `embedding_latency` histogram | Mimir | p95 > 1s |
| `llm_error_total` counter | Mimir | rate > 1/min (also a CloudWatch alarm) |
| `redaction_count` counter | Mimir | track per-source; sudden spike = source ACL regression |
| `circuit_open_total{source}` counter | Mimir | any non-zero value pages on-call |
| `rate_limit_hit_total{limit_type}` counter | Mimir | tracking, not alerting |

### 6.2 Logs → Grafana Cloud Loki

All app stdout/stderr ships to Loki via the Fluent Bit sidecar. Static stream
labels: `service=almanac,environment={env},source=ecs`. Per-record labels:
`$level`, `$traceId`. Jump from a trace in Tempo → the log stream for that
`trace_id` with one click.

Break-glass: Fluent Bit's own stderr (bootstrap / Loki push failures) lands in
the CloudWatch log group `/almanac/{env}/forwarder-diagnostics` — open that
when Grafana is showing silence and you suspect the forwarder.

### 6.3 CloudWatch alarms (infrastructure + SLO backstop)

Four alarms route via SNS (`AlarmTopicArn` output from the stack). Subscribe
PagerDuty, a Slack webhook, or an email to the topic.

| Alarm ID | Source | Threshold | Notes |
|---|---|---|---|
| `AuditDlqDepthAlarm` | `auditDlq` metricApproximateNumberOfMessagesVisible | ≥ 1 | Compliance — see RB-01 |
| `QueryP95LatencyAlarm` | `Almanac` namespace `QueryLatency` p95 | > 5000ms for 3 × 5min | See RB-02 |
| `LLMErrorAlarm` | `Almanac` namespace `LLMError` Sum | ≥ 5 in 5min | Bedrock failure rate |
| `AuditTotalLossAlarm` | `Almanac` namespace `AuditTotalLoss` Sum | ≥ 1 in 5min | Primary SQS + DLQ both failed — compliance-critical |

```bash
# Who is paged when these fire? (Lists topic subscriptions.)
aws sns list-subscriptions-by-topic \
  --topic-arn "$(aws cloudformation describe-stacks \
     --stack-name AlmanacProduction \
     --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" \
     --output text)"
```

### 6.4 Traces → Grafana Cloud Tempo

OTel spans from `http`/`fetch`/`aws-sdk`/`pg`/`ioredis` are auto-instrumented
via `NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"`
(see `Dockerfile`). The active-span `trace_id` is stamped on every log line by
the Pino mixin in `src/logger.ts`, so a one-liner error in Loki can be pivoted
to the full trace in Tempo in one click.

### 6.5 Dashboards

The primary ops dashboard lives in **Grafana Cloud → Dashboards → `Almanac`**
(provisioned out-of-band; not managed by this stack). CloudWatch no longer
hosts an Almanac dashboard — app metrics stopped flowing there when the OTel
migration landed.

---

## 7. Runbooks by Scenario

### RB-01: Audit DLQ Has Messages

**Symptom:** CloudWatch alarm `AuditDlqDepthAlarm` fires  
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

# 3. Check Lambda audit consumer errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/almanac-audit-consumer-production \
  --start-time $(date -d '1 hour ago' +%s000) \
  --filter-pattern ERROR

# 4. Common causes and fixes:
#    - DDB write throttle: Check DDB consumed capacity, scale if needed
#    - S3 write error: Check S3 bucket ACL/policy
#    - Lambda timeout: Check Lambda duration metric

# 5. Replay DLQ messages (after fixing root cause)
aws sqs change-message-visibility-batch \
  --queue-url DLQ_URL \
  --entries '[{"Id":"1","ReceiptHandle":"...","VisibilityTimeout":0}]'

# Move messages back to main queue for reprocessing
# (Use the SQS DLQ redrive feature in AWS Console)
```

### RB-02: High Query Latency (p50 > 3s)

**Symptom:** CloudWatch alarm fires for p50 query latency  
**Possible causes:** Bedrock throttling, pgvector slow queries, ACL check timeouts

```bash
# 1. Find slow queries in Loki (query via Grafana Cloud → Explore → Loki):
#    {service="almanac", environment="production"} |= "query processed" | json | latencyMs > 3000
#    Then copy a `trace_id` and pivot to Tempo for the full span tree.

# 2. Compare query_latency histogram in Mimir against baseline:
#    histogram_quantile(0.95, sum by (le) (rate(query_latency_bucket[5m])))
#    vs. the same expression over 24h ago.

# 3. Bedrock latency: the auto-instrumented `aws-sdk` span group has the
#    InvocationLatency broken down per model in Tempo. Filter by
#    service.name=almanac AND rpc.method=InvokeModel.

# 4. If Bedrock is the bottleneck:
#    - Check Bedrock service quotas (tokens per minute)
#    - Consider fallback to Claude 3 Haiku for simple queries
#    - Request quota increase via AWS Support

# 4. If ACL checks are the bottleneck:
#    - Check source system API latency (Notion/Confluence/Drive)
#    - Source system may be rate-limiting Almanac's service account
```

### RB-03: ACL Check Error Rate > 1%

**Symptom:** CloudWatch alarm fires for ACL error rate  
**Impact:** Possible conservative over-redaction (not under-redaction — fail-secure)

```bash
# Recent ACL-probe non-auth errors (Grafana Cloud → Explore → Loki):
#   {service="almanac"} |= "ACL probe non-auth error"
# Redactions by source:
#   sum by (source) (rate(redaction_count_total[5m]))    # in Mimir

# Circuit-breaker trips (one trip = O(5) consecutive failures → fail-secure):
#   {service="almanac"} |= "ACL probe short-circuited"
#   or: circuit_open_total{source="notion|confluence|drive"} in Mimir

# 401s typically mean user-specific token refresh — expected during
# extended user absence. Check getValidToken warnings:
#   {service="almanac"} |= "getValidToken failed"
```

### RB-04: ECS Service Not Running

**Symptom:** ECS running count < desired count

```bash
# Get task failure reasons
aws ecs describe-tasks \
  --cluster almanac-production \
  --tasks $(aws ecs list-tasks --cluster almanac-production --query 'taskArns[]' --output text)

# Roll a fresh image — re-runs the CDK asset build and deploys the new digest
npm run deploy:production

# Force the existing task def to redeploy (no code change, no asset rebuild)
aws ecs update-service \
  --cluster almanac-production \
  --service almanac-production \
  --force-new-deployment

# Rollback to a previous task definition revision
PREV_TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition almanac-production \
  --query 'taskDefinition.taskDefinitionArn' --output text | \
  sed 's/:[0-9]*$//')
# Update service to use a specific previous task def number, e.g. PREV_TASK_DEF:42
```

### RB-05: Redis Cluster Unavailable

**Symptom:** Connection errors to Redis in ECS logs  
**Impact:** Rate limiter fails open (queries still served; rate limit not enforced)  
**This is the designed behavior** — rate limiting is a fairness control, not a security gate

```bash
# Check Redis cluster status
aws elasticache describe-replication-groups \
  --replication-group-id almanac-production

# If cluster is down, ECS will log warnings but continue serving
# Rate limiting will not be enforced until Redis recovers
# Create CloudWatch alarm for Redis cluster unavailability

# For planned Redis maintenance: rate limiting is temporarily suspended
# Monitor for abnormal query volumes during Redis downtime
```

---

## 8. Connector Crawl Operations

```bash
# Last crawl time for each source (Grafana Cloud → Explore → Loki):
#   {service="almanac"} |= "crawl complete"

# Force immediate re-crawl (e.g., after bulk doc updates)
# Send a message to the crawl trigger queue or restart the ECS task
aws ecs update-service \
  --cluster almanac-production \
  --service almanac-production \
  --force-new-deployment

# Check pgvector chunk count
psql "$RETRIEVAL_BACKEND_URL" -c "SELECT count(*) FROM chunks"
```

---

## 9. Security Incident Response

### If cross-space data leak is suspected:
1. Immediately disable @almanac in Slack (revoke Bot Token in Slack app settings)
2. Page NanoCorp Security team
3. Export audit logs for the affected time window:
   ```bash
   aws dynamodb query \
     --table-name almanac-audit-production \
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
