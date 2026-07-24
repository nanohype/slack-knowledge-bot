# slack-knowledge-bot chart

Helm chart for slack-knowledge-bot (internal service handle: `slack-knowledge-bot`). Renders into a Platform tenant on the `eks-agent-platform` operator running on a nanohype-org EKS cluster.

## Files

- `Chart.yaml` — chart metadata
- `values.yaml` — base values (all environments)
- `values-staging.yaml` — staging delta
- `values-production.yaml` — production delta
- `templates/`
  - `deployment.yaml` — main app pod (env from values + secret refs from ExternalSecret)
  - `service.yaml` — ClusterIP on port 3001
  - `ingress.yaml` — `/health` and the OAuth start/callback routes on the `alb` class the eks-gitops load balancer controller serves; TLS terminates on the ALB against an ACM certificate
  - `serviceaccount.yaml` — name pinned to the app; bound to the operator-minted `<env>-slack-knowledge-bot-tenant` IAM role by a Pod Identity association (no role-arn annotation)
  - `externalsecret.yaml` — pulls app secrets + DB credentials from AWS Secrets Manager
  - `networkpolicy.yaml` — default-deny + egress allow-list
  - `audit-consumer-deployment.yaml` — long-running SQS consumer (`dist/bin/audit-consumer.js`); drains the audit queue → DynamoDB + S3
  - `audit-consumer-scaledobject.yaml` — KEDA `aws-sqs-queue` trigger scaling the audit-consumer 0..5 replicas off the queue depth, using the pod's IAM identity for SQS metrics
  - `prometheusrule.yaml` — QueryP95, LLMError, AuditTotalLoss, plus AuditDlqDepth behind `auditDlq.cloudwatchExporterEnabled`. Rendered only when `prometheusRule.enabled` is true — off by default, since the default stack (OpenTelemetry Collector → Amazon Managed Prometheus) runs no in-cluster Prometheus Operator to evaluate the rules
  - `grafana-dashboard.yaml` — GrafanaDashboard CR (instanceSelector `dashboards: external`) loading the dashboard from `dashboards/slack-knowledge-bot.json`, reconciled by the grafana-operator onto Amazon Managed Grafana
  - `_helpers.tpl` — name/label helpers

## Relationship to companion files

The chart alone is not enough to run the app. Two sibling files at the repo root complete the tenant trio:

- `../platform.yaml` — Platform CR declaring this app as a tenant of the `workplace` team. The operator reconciles the `tenants-slack-knowledge-bot` Namespace, ResourceQuota, LimitRange, default-deny NetworkPolicy, ArgoCD AppProject, and the tenant IAM role from this CR. Apply once during initial setup.
- `../gitops/applicationset-entry.yaml` — ApplicationSet entry registered into `nanohype/eks-gitops`. ArgoCD picks up the entry and rolls out this chart.

## Required landing-zone components

Single-tenant component `components/aws/tenant-substrate/` provisions everything the app's pods need:

- KMS key (per-user OAuth token envelope, annual rotation)
- DynamoDB ×3 — tokens / audit / identity-cache (all with TTL)
- SQS FIFO audit queue + DLQ
- S3 audit-archive bucket
- Aurora Serverless v2 (postgres 16.6, pgvector at app-bootstrap)
- ElastiCache Redis replication group (multi-AZ-gated)
- The tenant IAM role is operator-generated, not part of this substrate: the datastore-access policy (DDB rw, SQS rw, S3 PutObject) from `spec.datastores`, the agent-iam Bedrock baseline clamped to `spec.identity.allowedModels`, and the tenant's own Secrets Manager prefix. KMS Encrypt/Decrypt on the token-store key is a deferred follow-up (app-specific substrate outside the datastore vocabulary).

Bedrock invocation-logging-NONE is a Bedrock account+region setting owned by landing-zone's `cluster-bootstrap` (or a `bedrock-account-config` component), NOT per-tenant.

## Pod identity

One IAM role serves this Platform tenant. The eks-agent-platform operator mints it from the Platform CR; every pod in the tenant binds to it through an EKS Pod Identity association:

| Role                               | Owner                       | Bound service account                                             | Used by                                                     |
| ---------------------------------- | --------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `<env>-slack-knowledge-bot-tenant` | eks-agent-platform operator | `system:serviceaccount:tenants-slack-knowledge-bot:tenant-runtime` | The main pod + audit-consumer Deployment, and any AgentFleet pods |

The chart's `serviceaccount.yaml` references the operator-owned `tenant-runtime` ServiceAccount (`serviceAccount.create: false`) with no role-arn annotation. The operator creates the EKS Pod Identity association binding `(namespace, tenant-runtime)` to the tenant role, so EKS injects credentials through the standard AWS credential chain — no annotation, no role ARN in the chart. The ServiceAccount name must match the association's `service_account`, which is why it is pinned to the app name. KEDA's `aws-sqs-queue` trigger on the audit-consumer runs under its configured identity, so queue-depth scaling Just Works.

The role's Bedrock grant is the agent-iam baseline clamped to `Platform.spec.identity.allowedModels`. The app's substrate grants (DynamoDB, SQS, S3, KMS, Secrets Manager, CloudWatch) arrive as the operator-generated datastore-access policy (from spec.datastores). One Platform, one privilege domain.

## Render locally

```sh
helm template slack-knowledge-bot chart -f chart/values-staging.yaml > rendered-staging.yaml
helm lint chart
```

## Where the rest lives

This chart owns the app's k8s surface. The cloud substrate and cluster addons sit in other layers:

**Substrate (declared in `spec.datastores`, provisioned by `landing-zone/components/aws/tenant-substrate/`):** the `main` Aurora Serverless v2 (pgvector) store, three DynamoDB tables, the Redis `cache`, the FIFO audit queue + DLQ, and the S3 audit bucket. The operator generates the datastore-access policy and binds the operator-owned `tenant-runtime` ServiceAccount to the tenant role via a Pod Identity association. App secrets at `slack-knowledge-bot/<env>/app-secrets` are seeded out of band; `externalsecret.yaml` syncs them into a k8s Secret via ESO. The dedicated KMS token-envelope key is a deferred follow-up.

**Cluster addons (`eks-gitops`):** the AWS Load Balancer Controller + external-dns (which the `ingress` template depends on), cert-manager, the OpenTelemetry Collector gateway at `telemetry.monitoring.svc.cluster.local:4318` and the grafana-operator (→ Amazon Managed Grafana). The app writes structured JSON to stderr (tailed to Loki) and exports OTLP traces + metrics + logs to the collector gateway, which forwards traces → Tempo, metrics → Amazon Managed Prometheus, logs → Loki. No per-pod sidecars.

**This chart:** the main `Deployment`, the KEDA-scaled `audit-consumer-deployment.yaml` (`dist/bin/audit-consumer.js`, 0..5 replicas off SQS audit queue depth — consumer logic in `src/audit/audit-consumer.ts`, port-injected so unit tests fake the SDKs), the `ingress`, the default-deny `networkpolicy.yaml`, the `externalsecret.yaml`, plus observability that ships here rather than in eks-gitops:

- `prometheusrule.yaml` — QueryP95, LLMError, AuditTotalLoss, plus AuditDlqDepth behind `auditDlq.cloudwatchExporterEnabled`. Opt-in via `prometheusRule.enabled` for clusters running a Prometheus Operator; rule evaluation and alert routing are cluster-side concerns, not this chart's.
- `grafana-dashboard.yaml` — a `GrafanaDashboard` CR loading the dashboard from `chart/dashboards/slack-knowledge-bot.json`; the grafana-operator reconciles it onto the external Amazon Managed Grafana.

Bedrock invocation logging is disabled at the account/region level in landing-zone, not per-tenant.

## Follow-up work tracked separately

1. **Landing-zone tenant entries** in each of the substrate components (rag, pipeline, governance, llm, secrets). Coordinate with the landing-zone PR queue.
