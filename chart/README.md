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
  - `ingress.yaml` — ingress-nginx + cert-manager TLS
  - `serviceaccount.yaml` — name pinned to the app; bound to the landing-zone-owned slack-knowledge-bot-platform IAM role by a Pod Identity association (no role-arn annotation)
  - `externalsecret.yaml` — pulls app secrets + DB credentials from AWS Secrets Manager
  - `networkpolicy.yaml` — default-deny + egress allow-list
  - `audit-consumer-deployment.yaml` — long-running SQS consumer (`dist/bin/audit-consumer.js`); drains the audit queue → DynamoDB + S3
  - `audit-consumer-scaledobject.yaml` — KEDA `aws-sqs-queue` trigger scaling the audit-consumer 0..5 replicas off the queue depth, using the pod's IAM identity for SQS metrics
  - `prometheusrule.yaml` — four alerts (QueryP95, LLMError, AuditTotalLoss, AuditDlqDepth)
  - `grafana-dashboard.yaml` — GrafanaDashboard CR (instanceSelector `dashboards: external`) loading the dashboard from `dashboards/slack-knowledge-bot.json`, reconciled by the grafana-operator onto Amazon Managed Grafana
  - `_helpers.tpl` — name/label helpers

## Relationship to companion files

The chart alone is not enough to run the app. Two sibling files at the repo root complete the tenant trio:

- `../platform.yaml` — Platform CR declaring this app as a tenant of the `protohype` team. The operator reconciles Namespace, ResourceQuota, IAM role, KMS grants, S3 bucket policy from this CR. Apply once during initial setup.
- `../gitops/applicationset-entry.yaml` — ApplicationSet entry registered into `nanohype/eks-gitops` (or `aks-gitops`). ArgoCD picks up the entry and rolls out this chart.

## Required landing-zone components

Single-tenant component `components/aws/slack-knowledge-bot-platform/` provisions everything the app's pods need:

- KMS key (per-user OAuth token envelope, annual rotation)
- DynamoDB ×3 — tokens / audit / identity-cache (all with TTL)
- SQS FIFO audit queue + DLQ
- S3 audit-archive bucket
- Aurora Serverless v2 (postgres 16.6, pgvector at app-bootstrap)
- ElastiCache Redis replication group (multi-AZ-gated)
- IAM role with the consolidated inline policy (DDB rw, SQS rw, S3 PutObject, KMS Encrypt/Decrypt on the token-store key, Bedrock invoke for Claude Sonnet 4.6 + Titan embed v2, Secrets Manager read)

Bedrock invocation-logging-NONE is a Bedrock account+region setting owned by landing-zone's `cluster-bootstrap` (or a `bedrock-account-config` component), NOT per-tenant.

## Pod identity

Two IAM roles exist for this Platform tenant — different SAs, different policies, different owners:

| Role                                 | Owner                                                 | Trust                                                         | Used by                                             |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `<env>-slack-knowledge-bot-platform` | landing-zone `slack-knowledge-bot-platform` component | `system:serviceaccount:tenants-protohype:slack-knowledge-bot` | This chart's main pod + audit-consumer Deployment   |
| `<env>-slack-knowledge-bot-tenant`   | eks-agent-platform operator                           | `system:serviceaccount:tenants-protohype:tenant-runtime`      | AgentFleet pods (if/when any land in this Platform) |

The chart's `serviceaccount.yaml` creates a ServiceAccount named `slack-knowledge-bot` (pinned via `serviceAccount.name`) with no role-arn annotation. The landing-zone `slack-knowledge-bot-platform` component creates an EKS Pod Identity association binding that `(namespace, service-account)` to the IAM role, so EKS injects credentials through the standard AWS credential chain — no annotation, no role ARN in the chart. The ServiceAccount name must match the association's `service_account`, which is why it is pinned to the app name. KEDA's `aws-sqs-queue` trigger on the audit-consumer runs under its configured identity, so queue-depth scaling Just Works.

The operator-managed role is unused by this chart today and is harmless. It only matters once an AgentFleet CR lands in the `slack-knowledge-bot` Platform.

## Render locally

```sh
helm template slack-knowledge-bot chart -f chart/values-staging.yaml > rendered-staging.yaml
helm lint chart
```

## Where the rest lives

This chart owns the app's k8s surface. The cloud substrate and cluster addons sit in other layers:

**Substrate (`landing-zone/components/aws/slack-knowledge-bot-platform/`):** VPC + private subnets, DynamoDB ×3, ElastiCache Redis, Aurora Serverless v2 (pgvector), SQS + DLQ, S3 audit bucket, KMS token-store key, and the seeded Secrets Manager `slack-knowledge-bot/<env>/app-secrets`. It binds the role to the chart's ServiceAccount via an EKS Pod Identity association. AWS Secrets Manager stays the source of truth; the chart's `externalsecret.yaml` syncs it into a k8s Secret via ESO.

**Cluster addons (`eks-gitops`):** ingress-nginx, cert-manager + external-dns (fronted by the `ingress` template), the grafana-agent (Alloy) OTLP receiver at `grafana-agent.monitoring.svc.cluster.local:4318` and the grafana-operator (→ Amazon Managed Grafana). The app writes structured JSON to stderr (tailed to Loki) and exports OTLP traces + metrics + logs to grafana-agent, which forwards traces → Tempo, metrics → Amazon Managed Prometheus, logs → Loki. No per-pod sidecars.

**This chart:** the main `Deployment`, the KEDA-scaled `audit-consumer-deployment.yaml` (`dist/bin/audit-consumer.js`, 0..5 replicas off SQS audit queue depth — consumer logic in `src/audit/audit-consumer.ts`, port-injected so unit tests fake the SDKs), the `ingress`, the default-deny `networkpolicy.yaml`, the `externalsecret.yaml`, plus observability that ships here rather than in eks-gitops:

- `prometheusrule.yaml` — four alerts: AuditDlqDepth, QueryP95, LLMError, AuditTotalLoss. Alertmanager (eks-gitops) routes them to PagerDuty / Slack.
- `grafana-dashboard.yaml` — a `GrafanaDashboard` CR loading the dashboard from `chart/dashboards/slack-knowledge-bot.json`; the grafana-operator reconciles it onto the external Amazon Managed Grafana.

Bedrock invocation logging is disabled at the account/region level in landing-zone, not per-tenant.

## Follow-up work tracked separately

1. **Landing-zone tenant entries** in each of the substrate components (rag, pipeline, governance, llm, secrets). Coordinate with the landing-zone PR queue.
