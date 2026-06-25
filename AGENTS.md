# slack-knowledge-bot — agent entry point

You're an AI client (or the author of one) about to run this service locally, add a knowledge source, wire a new OAuth provider, or ship it as a Platform tenant. This file gets you running in five minutes. For the wider picture — how this repo fits into the nanohype stack — read the [Platform Reference](../nanohype/docs/platform-reference.md).

> Internal service handle: **slack-knowledge-bot**. The GitHub repo and product name are `slack-knowledge-bot`, but the npm package, OTel `service.name` / `agents.platform`, the `/slack-knowledge-bot` slash command, and the `slack-knowledge-bot/<env>/*` secret prefixes stay `slack-knowledge-bot` — they're coupled to the landing-zone `slack-knowledge-bot-platform` substrate component.

## What this repo gives you

An internal Slack knowledge bot: employees @mention it or DM it, and it answers grounded in their own access-controlled documents across Notion, Confluence, and Google Drive. Every answer cites sources with URLs and last-modified timestamps. The load-bearing property is that **the ACL check runs after retrieval, against the asking user's own OAuth tokens** — a document that scores high in the index is dropped if that user can't read it in the source system. There's no shared service-account view of company knowledge.

It's built as a reusable subsystem. Every external-IO service is a `createXxx(deps)` factory accepting typed ports (`typeof fetch`, a narrow `RedisPort`, a `RetrievalBackend`, or an AWS SDK client). `src/index.ts` is the single place real SDK clients are constructed; everything downstream runs against port interfaces, so swapping Redis → Valkey, WorkOS → Okta/Entra/Google Admin, pgvector → OpenSearch/Qdrant/Pinecone, or Bedrock → another LLM is a one-file change.

## Run it in five minutes

```bash
npm install                # installs the app + the file:-linked packages/oauth
cp .env.example .env       # fill in the required keys (see CLAUDE.md > Configuration)
npm run dev                # tsx watch src/index.ts — serves :3001 (/health + /oauth/*)
```

In Slack: `@slack-knowledge-bot what's our vacation policy?`

```bash
npm run check              # typecheck + lint + format:check + test (CI parity, one shot)
```

## Contract surface

Shipping this on a cluster means three artifacts travel together: the **Platform CR**, the **Helm chart**, and the **gitops entry**. They're the tenant contract.

### The Platform CR (`platform.yaml`)

Two CRs in different groups — a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`) and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references it:

```yaml
apiVersion: governance.nanohype.dev/v1alpha1
kind: BudgetPolicy
metadata:
  name: slack-knowledge-bot
  namespace: tenants-protohype
spec:
  platformRef: { name: slack-knowledge-bot }
  monthlyUsd: "5000" # kill-switch fires at 120% (USD 6000)
  alertThresholdsPercent: [50, 80, 100]
  killSwitchEnabled: true
---
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: slack-knowledge-bot
  namespace: tenants-protohype
spec:
  displayName: slack-knowledge-bot
  persona: support
  tenant: protohype
  budget: { name: slack-knowledge-bot }
  identity:
    allowedModelFamilies: [anthropic, amazon] # Claude (LLM) + Titan (embeddings)
    extraPolicyArns: [] # app pods assume the landing-zone role directly
  compliance: { soc2: true }
  isolation: namespace
```

The operator reconciles the namespace `tenants-protohype`, ResourceQuota, LimitRange, default-deny NetworkPolicy, ArgoCD AppProject, and a per-Platform IAM role trusting the `tenant-runtime` SA. **slack-knowledge-bot's own app pods don't use that operator role** — they assume the landing-zone `slack-knowledge-bot-platform` IRSA role directly via the EKS Pod Identity association. `extraPolicyArns` stays empty for that reason.

### The Helm chart (`chart/`)

The application Deployment plus everything that supports it. Templates under `chart/templates/`:

| Template                                                              | Owns                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.yaml`                                                     | The main pod (Bolt + HTTP server on :3001)                                                                                            |
| `service.yaml`                                                        | ClusterIP :3001                                                                                                                       |
| `ingress.yaml`                                                        | ingress-nginx + cert-manager TLS for `/health` and `/oauth/:provider/{start,callback}`                                                |
| `serviceaccount.yaml`                                                 | Shared SA for the main pod + audit-consumer, name pinned to the app; bound to the landing-zone IAM role by a Pod Identity association |
| `externalsecret.yaml`                                                 | ESO syncs `slack-knowledge-bot/<env>/app-secrets` + `slack-knowledge-bot/<env>/db-credentials` from Secrets Manager                   |
| `networkpolicy.yaml`                                                  | Default-deny + egress allow-list (AWS APIs, Slack/WorkOS/Notion/Confluence/Drive HTTPS, RDS + Redis on the VPC CIDR)                  |
| `audit-consumer-deployment.yaml` + `audit-consumer-scaledobject.yaml` | The SQS-drain Deployment (`dist/bin/audit-consumer.js`), KEDA-scaled 0..5 on audit queue depth                                        |
| `prometheusrule.yaml`                                                 | Four alerts — QueryP95, LLMError, AuditTotalLoss, AuditDlqDepth                                                                       |
| `grafana-dashboard.yaml`                                              | ConfigMap loading `chart/dashboards/slack-knowledge-bot.json`                                                                         |

`values.yaml` is the base; `values-staging.yaml` / `values-production.yaml` carry the per-env deltas (image tag, replica count). The image is `ghcr.io/nanohype/slack-knowledge-bot`. OTel attrs `agents.tenant=protohype` + `agents.platform=slack-knowledge-bot` are set in every values file (required by the platform-tenant contract).

### Required tenant files

A valid tenant in this repo is exactly these three, plus the chart's per-env values:

- `platform.yaml` — the `BudgetPolicy` + `Platform` CRs
- `chart/` — the chart above, with `values.yaml` + `values-staging.yaml` + `values-production.yaml`
- `gitops/applicationset-entry.yaml` — the ApplicationSet entry registered into `nanohype/eks-gitops` (matrix generator over clusters × the app, Helm multi-source `$values` resolving `values.yaml` + `values-<env>.yaml`)

## Add a connector

A "connector" is a knowledge source the bot can verify per-user access against (Notion / Confluence / Drive today). Connectors live in `src/connectors/` behind a `ConnectorVerifier` registry (`src/connectors/registry.ts`). To add a fourth:

1. **Extend the source tuple** — add the source name to `SUPPORTED_SOURCES` in `src/connectors/types.ts`. Every module that iterates sources (ACL guard, query handler, disconnect command) reads this tuple, so this one edit widens them all.
2. **Write the verifier** — add `src/connectors/<source>.ts` modeled on `notion.ts`. Call `registerVerifier({ source, async probe(hit, token, fetchImpl) {...} })`. The probe hits the source API with the injected `fetchImpl` and the per-user `accessToken`, and throws `AclProbeError(status, source)` on non-2xx. **Take `fetchImpl` as a parameter — never reach for global `fetch`** (the ACL guard owns the HTTP port and the CI bare-`fetch(` ban enforces it).
3. **Register at boot** — make sure the new module is imported so its `registerVerifier` side-effect runs (same pattern as the existing connectors).
4. **Map source → OAuth provider** — if the source uses a new identity provider, add the source→provider mapping in `src/oauth/router.ts` (`SOURCE_TO_PROVIDER`) and follow the OAuth walkthrough below.
5. **Test it** — add `src/connectors/<source>.test.ts` with a `vi.fn<typeof fetch>()` covering 200-grants, 403/404-redact, missing-token, network-error, and circuit-breaker-trip cases. Fail-secure is the contract: any failure → `wasRedacted: true`.

## Add an OAuth provider

OAuth providers live in the in-repo `packages/oauth` package (the `slack-knowledge-bot-oauth` module, scaffolded from nanohype's `module-oauth-delegation` template) under `packages/oauth/src/oauth/providers/`. Built-ins: Notion, Google, Atlassian, Slack, HubSpot. To add one:

1. **Write the adapter** — add `packages/oauth/src/oauth/providers/<name>.ts` modeled on `notion.ts`. Export an `OAuthProvider` object (`authUrl`, `tokenUrl`, `defaultScopes`, `usePkce`, `tokenAuthStyle`, `parseTokenResponse`) and call `registerProvider("<name>", () => <name>Provider)` at module load.
2. **Wire the barrel** — add a side-effect `import "./<name>.js"` and a named re-export to `packages/oauth/src/oauth/providers/index.ts` so consumers can pass the adapter directly.
3. **Surface it to the app** — in `src/oauth/router.ts`, add the provider to the `providers` map and a `clientCredentials.<name>` block (client id/secret/redirect URI), and add the config keys to `src/config/index.ts` + `.env.example`. If a knowledge source maps to it, update `SOURCE_TO_PROVIDER`.
4. **Build the package** — `npm run build:oauth` (the Dockerfile rebuilds `packages/oauth/dist` on image build).
5. **Test it** — add `packages/oauth/src/oauth/__tests__/providers/<name>.test.ts` covering the auth-URL shape, token-response parsing, and PKCE/auth-style behavior.

## Conventions

- **Ports, not SDK patches.** Every cross-boundary service is a `createXxx(deps)` factory taking typed ports; tests inject fakes. AWS SDK clients use `aws-sdk-client-mock` (client-level), never module-level mocks.
- **Three grep-enforced CI invariants** (the app's load-bearing guardrails):
  - **No SDK mocks** — `vi.mock(<sdk-package>)` is banned. Accept the SDK client as a typed dep and inject a fake.
  - **No bare `fetch(`** — whitelisted only in `src/index.ts`, `src/connectors/`, `src/identity/workos-resolver.ts`, `src/oauth/`, and lines tagged `// allow-fetch`. Everything else takes `fetchImpl`.
  - **No `new WebClient(`** — Slack `WebClient` construction is whitelisted only in `src/index.ts` and `src/slack/`. Handlers receive the client as a dep.
- **Fail-secure ACL, fail-open ratelimit.** An ACL probe that errors, times out, or hits an open circuit breaker drops the document (`wasRedacted: true`). The rate limiter does the opposite — if Redis is unreachable it lets the request through (throttling is not authentication).
- TypeScript strict, ESM NodeNext, Node ≥ 24. Zod at every boundary. Pino JSON to stderr with OTel `trace_id`/`span_id` correlation. Explicit timeouts on every external call. ESLint flat config + typescript-eslint v8 (no warnings), Prettier.
- Coverage thresholds: 75 / 60 / 75 / 75 (statements / branches / functions / lines).

## Pointers

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — bounded contexts, the data-flow pipeline, load-bearing decisions, and where the boundaries sit (landing-zone substrate, eks-gitops addons)
- [`CLAUDE.md`](CLAUDE.md) — per-module breakdown, configuration, full conventions, test map
- [`README.md`](README.md) — front door: run, test, deploy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the connector / OAuth-provider recipes + the test contract + PR flow
- [`chart/README.md`](chart/README.md) — template-by-template chart reference + the per-tenant infra it expects
- [`docs/`](docs/) — PRD, RAG architecture, QA playbook, threat model, compliance checklist, runbook, integrations, secrets, onboarding, test plan
- [Platform Reference](../nanohype/docs/platform-reference.md) — the stack-wide view
- [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) — the operator that reconciles the Platform CR
- [`landing-zone`](https://github.com/nanohype/landing-zone) — the `slack-knowledge-bot-platform` substrate the chart's IAM role and data stores live in
