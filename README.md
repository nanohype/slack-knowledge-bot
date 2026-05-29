# slack-knowledge-bot

![Build](https://github.com/nanohype/slack-knowledge-bot/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/License-Apache--2.0-green)
![Node](https://img.shields.io/badge/Node-%3E%3D24-339933?logo=node.js)
![Kubernetes](https://img.shields.io/badge/Kubernetes-Tenant-326CE5?logo=kubernetes)

Internal Slack knowledge bot — answers employee questions over Notion, Confluence, and Google Drive with per-user, ACL-filtered retrieval. Every retrieval is bounded to what the asking user can already read in the source system; every answer cites its sources. The internal service handle is `almanac` (npm package, OTel `service.name`, the `/almanac` slash command, and the `almanac/<env>/*` secret prefixes).

**AI clients / agents start here:** [`AGENTS.md`](AGENTS.md). For the stack-wide view, see the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

## What it is

A Slack bot that answers grounded questions over a company's knowledge sources. The ACL check runs _after_ retrieval, against the asking user's own OAuth tokens — a document scoring high in the index is dropped if the user can't read it in the source system. There is no shared service-account view of company knowledge, so a query can only surface what that user could already see. Bedrock (Claude Sonnet for generation, Titan for embeddings) runs on-account via IRSA; no source content leaves the account.

Built as a reusable subsystem: every external-IO service is a `createXxx(deps)` factory accepting typed ports (`typeof fetch`, a narrow `RedisPort`, a `RetrievalBackend`, or an AWS SDK client). `src/index.ts` constructs the real clients once and threads them through, so swapping Redis, the directory provider, the retrieval backend, or the LLM is a one-file change. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the bounded contexts and data flow.

## Quickstart

```bash
npm install
cp .env.example .env   # fill in values — see CLAUDE.md > Configuration
npm run dev            # tsx watch on src/index.ts
```

In Slack: `@almanac what's our vacation policy?`

Run the full local gate before pushing:

```bash
task ci   # build + lint + typecheck + test + format:check + helm lint/template + docker build
```

## Deploy

Ships as a [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) Platform tenant. The trio:

- **`chart/`** — the application Helm chart: Deployment + Service + Ingress (ingress-nginx + cert-manager) + NetworkPolicy + ServiceAccount (IRSA) + ExternalSecret (ESO), plus the KEDA-scaled audit consumer, PrometheusRule alerts, and a Grafana dashboard. Per-env deltas in `chart/values-{staging,production}.yaml`.
- **`platform.yaml`** — the `Platform` CR + `BudgetPolicy` declaring the tenant boundary (`tenant: protohype`, namespace `tenants-protohype`). The operator reconciles the Namespace, ResourceQuota, IRSA role, KMS grants, S3 bucket policy, and ArgoCD AppProject.
- **`gitops/applicationset-entry.yaml`** — the ApplicationSet entry registered into [`nanohype/eks-gitops`](https://github.com/nanohype/eks-gitops) for ArgoCD reconciliation.

The AWS substrate — DynamoDB tables, SQS + DLQ, S3 audit bucket, Aurora Serverless v2 (pgvector), ElastiCache Redis, KMS token key, Secrets Manager seeding — is provisioned by the `almanac-platform` component in [`landing-zone`](https://github.com/nanohype/landing-zone). Its `irsa_role_arn` output feeds the chart's `aws.platformRoleArn`. Apply `platform.yaml` once, wait for `Ready`, then ArgoCD owns the rollout: bump `image.tag` in the per-env values, commit, push.

## Boundaries

This repo owns the application — the Slack pipeline, the RAG logic, the per-user ACL enforcement, and the tenant trio that deploys it. It does **not** own:

- AWS substrate (DynamoDB, SQS, S3, Aurora/pgvector, Redis, KMS, Secrets Manager) → the `almanac-platform` component in [`landing-zone`](https://github.com/nanohype/landing-zone)
- Cluster addons (ingress-nginx, cert-manager, external-secrets, KEDA, the OTel collector + log forwarder, kube-prometheus-stack) → [`eks-gitops`](https://github.com/nanohype/eks-gitops)

## License

Apache-2.0.
