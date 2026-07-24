# slack-knowledge-bot — Compliance Checklist
**Author:** ops-compliance  
**Frameworks:** SOC 2 Type II (Security + Availability), GDPR (if EU employees), NanoCorp Data Policy

---

## 1. SOC 2 Trust Service Criteria

### CC6 — Logical and Physical Access Controls

| Control | Implementation | Evidence |
|---------|---------------|----------|
| CC6.1 — Access provisioning | WorkOS Directory Sync + SCIM; per-user OAuth required before any data access | WorkOS audit log; the OAuth flow |
| CC6.2 — Access removal | OAuth tokens have 2-year DDB TTL; user offboarding via WorkOS Directory Sync (suspend → token refresh fails → access denied) | Directory Sync provisioner; DDB TTL |
| CC6.3 — Least-privilege access | Pod IAM role: GetItem/PutItem only (no Scan); Bedrock: specific model IDs only | The `<env>-slack-knowledge-bot-tenant` role — the operator-generated datastore-access policy + the operator's `bedrock-model-scoping` clamp |
| CC6.6 — Data transmission security | All external calls HTTPS; Redis TLS enforced; VPC private subnets; default-deny NetworkPolicy + egress allow-list | TLS enforced in code; `networkpolicy.yaml` |
| CC6.7 — Data encryption at rest | DDB encrypted (AWS-managed KMS); S3 encrypted; token KMS envelope encryption | landing-zone `tenant-substrate` substrate |
| CC6.8 — Malware/vulnerability controls | Image scan (trivy) + dependency scanning in CI | `security.yml`; `npm audit` in CI |

### CC7 — System Operations

| Control | Implementation | Evidence |
|---------|---------------|----------|
| CC7.1 — Vulnerability detection | image scan (trivy); GitHub Dependabot/Renovate; npm audit CI step | CI pipeline |
| CC7.2 — Monitoring anomalies | **Partially operating.** Telemetry is collected: the app exports OTLP to the OpenTelemetry Collector, which remote-writes metrics to Amazon Managed Prometheus and ships traces to Tempo and logs to Loki; the ops dashboard is reconciled onto Amazon Managed Grafana. Nothing evaluates the anomaly expressions — see gap G-01. Detection is a human reading the dashboard or running PromQL. | `grafana-dashboard.yaml`; AMP/AMG query history. `prometheusrule.yaml` is **not** evidence — it ships disabled |
| CC7.3 — Incident response | **Partially operating.** `docs/runbook.md` documents triage, escalation, and recovery per scenario, and is exercised by hand. There is no automated trigger: nothing pages, and nothing posts to a Slack channel — see gap G-01. | `docs/runbook.md` |

### CC9 — Risk Mitigation

| Control | Implementation | Evidence |
|---------|---------------|----------|
| CC9.1 — Vendor risk | Bedrock on-account (no third-party LLM data sharing); AWS enterprise agreement | Architecture doc |
| CC9.2 — Business continuity | Multiple Deployment replicas; DDB PITR; Redis multi-AZ | landing-zone substrate + chart |

### A1 — Availability

| Control | Implementation | Evidence |
|---------|---------------|----------|
| A1.1 — Capacity planning | Aurora Serverless v2 pgvector (scales on load); HPA/KEDA scaling; rate limiter prevents abuse | chart + landing-zone substrate |
| A1.2 — Monitoring | Grafana dashboard; pod liveness/readiness probes | `grafana-dashboard.yaml`; `deployment.yaml` probes |
| A1.3 — Recovery | ArgoCD rollback to last-good revision; DDB point-in-time recovery | gitops + landing-zone substrate |

### Control gaps

Recorded here so no one attests to a control by reading past its absence.

**G-01 — no alert evaluation and no notification path.**

The cluster observability stack in
[`eks-gitops/addons/observability/`](https://github.com/nanohype/eks-gitops/tree/main/addons/observability)
is the OpenTelemetry Collector (OTLP in on 4317/4318, `otelcol.exporter.prometheus` →
`prometheus.remote_write` to Amazon Managed Prometheus over SigV4, traces to
Tempo, logs to Loki), plus kube-state-metrics, OpenCost, and the Grafana
operator. `addons/bootstrap/` installs `prometheus-operator-crds` — the CRDs
only. Two things follow:

- **Nothing evaluates rules.** No Prometheus Operator ruler and no
  kube-prometheus-stack run on these clusters, which is why this chart's
  `prometheusrule.yaml` ships `prometheusRule.enabled: false`. The
  `QueryP95LatencyBreach`, `LLMErrorRateSpike`, `AuditTotalLoss`, and
  `AuditDlqDepthHigh` expressions are declared, reviewed, and unevaluated.
- **Nothing routes a notification.** There is no Alertmanager in the catalog,
  and no `GrafanaContactPoint` or `GrafanaNotificationPolicy` either. No alert
  from this tenant reaches PagerDuty, Slack, or email.

Closing it means authoring the four expressions as a `GrafanaAlertRuleGroup`
evaluated by Amazon Managed Grafana against AMP — the delivery path the
platform's own SLO rules already use — and provisioning a contact point plus
notification policy in `eks-gitops`. Both are cluster-side work, outside this
repo. Until they land, CC7.2 detection is manual and CC7.3 has a procedure with
no trigger; neither should be represented as automated.

---

## 2. GDPR Controls (applicable if NanoCorp has EU employees)

| Article | Requirement | Implementation |
|---------|-------------|---------------|
| Art. 5 — Data minimization | Audit log stores `scrubbed_query`, not raw text; no source content stored | PII scrubber; no content persistence |
| Art. 13 — Transparency | The onboarding DM explains data collection | Onboarding playbook |
| Art. 17 — Right to erasure | `deleteTokens(userId)` API in token store; audit log can be expunged by userId partition delete | `token-store.ts` deleteTokens |
| Art. 25 — Privacy by design | ACL enforcement by design; PII scrubbing by default; no content stored permanently | Architecture |
| Art. 30 — Records of processing | This document serves as processing record | This document |
| Art. 32 — Security of processing | KMS encryption; TLS in transit; VPC isolation; NetworkPolicy; least-privilege pod IAM role | chart + landing-zone substrate |
| Art. 33 — Breach notification | ops-incident runbook includes 72-hour breach notification SLA | Runbook |

### GDPR Data Inventory

| Data Element | Purpose | Retention | Location | Legal Basis |
|-------------|---------|-----------|----------|-------------|
| Slack user_id | Identity resolution | 1h cache (DDB) | DDB identity-cache table | Legitimate interest (internal tool) |
| directory user_id | Token storage key | 2 years (DDB TTL) | DDB token table | Legitimate interest |
| Encrypted OAuth tokens | Source API access | 2 years or until revoked | DDB token table + KMS | Consent (OAuth flow) |
| Scrubbed query text | Audit trail | 1 year | DDB (90 days) + S3 (365 days) | Legitimate interest |
| Query hash | Deduplication | 1 year | DDB + S3 | Legitimate interest |
| Retrieved doc IDs | Audit trail | 1 year | DDB + S3 | Legitimate interest |
| Answer hash | Audit trail | 1 year | DDB + S3 | Legitimate interest |

---

## 3. NanoCorp Internal Data Policy

| Policy | Requirement | Status |
|--------|-------------|--------|
| Data residency | All data in us-west-2 | ✅ landing-zone substrate provisions us-west-2 only |
| Audit trail | All data access audited | ✅ Audit log for every query |
| No data exfiltration | Source content not sent to third parties | ✅ Bedrock on-account; no third-party LLM |
| Token security | No plaintext secrets in code or logs | ✅ KMS encryption; no logging of tokens |
| Access control | Read-only to source systems | ✅ Connectors use GET/read APIs only |

---

## 4. Compliance Checklist — Pre-Launch Gates

### Security Controls
- [ ] Red-team ACL leak test passed (RT-01 through RT-06 in threat model)
- [ ] FINDING-01: IAM least-privilege fix deployed and verified
- [ ] FINDING-02: Bedrock logging opt-out configured at account level
- [ ] FINDING-03: Redis TLS enforced in client config
- [ ] Image scan (trivy): zero HIGH/CRITICAL vulnerabilities
- [ ] `npm audit`: zero HIGH/CRITICAL vulnerabilities

### Data Controls
- [ ] GDPR data inventory reviewed by NanoCorp DPO (if applicable)
- [ ] Onboarding DM privacy notice reviewed
- [ ] PII scrubber tested against all patterns
- [ ] Audit log retention policy configured (90-day DDB TTL + 365-day S3 lifecycle)
- [ ] Audit DLQ depth alerting in place — **blocked on G-01**: the expression exists, nothing evaluates or routes it

### Access Controls
- [ ] WorkOS Directory connected
- [ ] OAuth applications registered in Notion, Confluence, Google Cloud
- [ ] Per-user OAuth consent flow tested end-to-end
- [ ] Token revocation tested (directory offboarding → access denied)

### Operational Controls
- [ ] Grafana dashboard configured
- [ ] **G-01 closed** — the four alert expressions authored as a `GrafanaAlertRuleGroup` in `eks-gitops`, a contact point and notification policy provisioned, and one rule fired end-to-end to a real destination. Nothing pages until this is done
- [ ] Runbook reviewed by ops team
- [ ] DRP (Disaster Recovery Plan) documented
- [ ] Change management process documented

---

## 5. Audit Log Retention Policy (Formal)

**Policy:** Audit logs are retained for a minimum of 12 months from the date of creation.

**Implementation:**
- Hot tier (DynamoDB): 90-day TTL — enables fast querying for recent investigations
- Cold tier (S3): 365-day lifecycle expiration — Intelligent Tiering for cost optimization
- Deletion: S3 lifecycle rule expires objects at day 365; DDB TTL handles hot tier

**Access to audit logs:** Restricted to NanoCorp Security team and designated HR/Legal staff via IAM role. Not accessible to general employees or the service itself.

**Integrity:** S3 objects are immutable (no in-place overwrite); DDB PITR enabled in production.

**Compliance note:** If NanoCorp is subject to specific regulatory retention requirements beyond 1 year, extend the S3 lifecycle expiration accordingly.
