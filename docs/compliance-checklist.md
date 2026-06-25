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
| CC6.3 — Least-privilege access | Pod IAM role: GetItem/PutItem only (no Scan); Bedrock: specific model ARNs only | IRSA policy on the landing-zone `slack-knowledge-bot-platform` role |
| CC6.6 — Data transmission security | All external calls HTTPS; Redis TLS enforced; VPC private subnets; default-deny NetworkPolicy + egress allow-list | TLS enforced in code; `networkpolicy.yaml` |
| CC6.7 — Data encryption at rest | DDB encrypted (AWS-managed KMS); S3 encrypted; token KMS envelope encryption | landing-zone `slack-knowledge-bot-platform` substrate |
| CC6.8 — Malware/vulnerability controls | Image scan (trivy) + dependency scanning in CI | `security.yml`; `npm audit` in CI |

### CC7 — System Operations

| Control | Implementation | Evidence |
|---------|---------------|----------|
| CC7.1 — Vulnerability detection | image scan (trivy); GitHub Dependabot/Renovate; npm audit CI step | CI pipeline |
| CC7.2 — Monitoring anomalies | PrometheusRule alerts: DLQ depth, query latency p95, LLM error rate, audit total loss | `prometheusrule.yaml`; Grafana dashboard |
| CC7.3 — Incident response | ops-incident runbook; Alertmanager → PagerDuty/Slack routing | Runbook document |

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

---

## 2. GDPR Controls (applicable if NanoCorp has EU employees)

| Article | Requirement | Implementation |
|---------|-------------|---------------|
| Art. 5 — Data minimization | Audit log stores `scrubbed_query`, not raw text; no source content stored | PII scrubber; no content persistence |
| Art. 13 — Transparency | The onboarding DM explains data collection | Onboarding playbook |
| Art. 17 — Right to erasure | `deleteTokens(userId)` API in token store; audit log can be expunged by userId partition delete | `token-store.ts` deleteTokens |
| Art. 25 — Privacy by design | ACL enforcement by design; PII scrubbing by default; no content stored permanently | Architecture |
| Art. 30 — Records of processing | This document serves as processing record | This document |
| Art. 32 — Security of processing | KMS encryption; TLS in transit; VPC isolation; NetworkPolicy; IRSA least-privilege | chart + landing-zone substrate |
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
- [ ] DLQ alert configured and routed to ops team

### Access Controls
- [ ] WorkOS Directory connected
- [ ] OAuth applications registered in Notion, Confluence, Google Cloud
- [ ] Per-user OAuth consent flow tested end-to-end
- [ ] Token revocation tested (directory offboarding → access denied)

### Operational Controls
- [ ] Grafana dashboard configured
- [ ] Alertmanager → PagerDuty/Slack routing tested
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
