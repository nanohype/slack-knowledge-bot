# Almanac — Product Requirements Document
**Version:** 1.0  
**Client:** NanoCorp  
**Author:** product  
**Status:** APPROVED

---

## 1. Problem Statement

NanoCorp employees (engineering, sales, ops) waste hours hunting across Notion, Confluence, and Google Drive. Tribal knowledge is not searchable. Existing Slack search is keyword-only and does not cross tools. Answers are often stale, sourced from memory rather than canonical documentation, and not attributed.

## 2. Solution

**Almanac** is an internal Slack bot that answers natural-language questions grounded in NanoCorp's knowledge bases (Notion, Confluence, Google Drive). Every answer cites sources with page/doc URLs and last-modified timestamps. Results are filtered to what the asking user has access to in the source system — no data leaks across private spaces.

Users invoke the bot as `@almanac` in Slack channels and DMs.

## 3. Goals & Non-Goals

### Goals
- Surface accurate, cited answers from NanoCorp's existing knowledge corpus
- Respect per-user ACLs in every source system end-to-end
- Provide full audit trail for compliance and security
- Deploy on AWS within budget and 3-week window

### Non-Goals (Out of Scope)
- Writing back to source systems (read-only only)
- Voice and mobile SDK
- Cross-workspace federation (single Slack workspace only)
- Ingesting systems other than Notion, Confluence, Google Drive

## 4. User Stories

| ID | Persona | Story | Acceptance Criteria |
|----|---------|-------|---------------------|
| US-01 | Engineer | As an engineer, I want to ask `@almanac` a question in a DM and get a cited answer in <3s | p50 latency <3s; answer contains source URL + timestamp |
| US-02 | Sales rep | As a sales rep, I want Almanac to only show me docs I have access to | Red-team test passes with zero cross-space leaks |
| US-03 | Any employee | As an employee, I want to know when a cited doc is outdated | Stale-source warning (⚠️) surfaces when doc is >90 days old |
| US-04 | Ops manager | As an ops manager, I want every Almanac query auditable | Audit log includes user ID, query, retrieved doc IDs, timestamp; retained 1 year |
| US-05 | Admin | As an admin, I want Almanac to tell users "I don't have access" — not expose redacted content | ACL-filtered fallback message on all redacted hits |
| US-06 | Engineer | As an engineer, I want OAuth re-authorization prompts when my token expires | OAuth refresh flow in DM, then answer resumes |

## 5. Functional Requirements

### 5.1 Query & Answer
- FR-01: Almanac MUST accept natural-language questions via `@almanac <question>` in channels and DMs
- FR-02: Almanac MUST return an answer within 3s (p50) under expected load
- FR-03: Every answer MUST include ≥1 source citation with: URL, doc title, last-modified timestamp
- FR-04: Stale-source warning (⚠️ Heads up: this doc was last updated >90 days ago) MUST appear when any cited doc is >90 days old
- FR-05: Almanac MUST respond in the same channel/thread where invoked; responses are ephemeral where possible

### 5.2 Identity & Access Control
- FR-06: Almanac MUST propagate per-user identity from Slack → workforce directory → source-system OAuth on every query
- FR-07: Almanac MUST NOT return content from a source-system doc the requesting user does not have access to
- FR-08: When a retrieval hit is access-denied for the requesting user, Almanac MUST respond: "I found a potentially relevant document but don't have permission to access it on your behalf."
- FR-09: Per-user OAuth tokens MUST be stored in DynamoDB with shared-secret encryption — not one Secrets Manager secret per user (must scale to 10k+ users cost-effectively)

### 5.3 Audit & Compliance
- FR-10: Every query MUST emit an audit event containing: user_id, slack_channel_id, query_text (PII-scrubbed), retrieved_doc_ids, answer_hash, timestamp
- FR-11: Audit events MUST be retained for 1 year minimum
- FR-12: Audit pipeline MUST include retry + DLQ on transient failures
- FR-13: Source content MUST NOT be stored in model-provider logs — prompt caching with PII scrubbing REQUIRED

### 5.4 Rate Limiting
- FR-14: Rate limiter MUST use shared state (Redis or DynamoDB) — in-memory Maps are NOT permitted (multi-instance deployment)
- FR-15: Default rate limits: 20 queries/user/hour, 500 queries/workspace/hour (configurable via env)

### 5.5 Connectors
- FR-16: Notion connector: page search, block content fetch, last-edited-time, shared-with metadata
- FR-17: Confluence connector: page search, content fetch, last-modified, space permissions
- FR-18: Google Drive connector: file search, content fetch (Docs, Sheets summary, PDFs), last-modified, Drive ACL check
- FR-19: Connector failures MUST surface as partial-answer warnings, not silent omissions

### 5.6 Source Freshness
- FR-20: Almanac MUST display last-modified timestamp for every cited source
- FR-21: Almanac MUST emit stale-source warning for docs >90 days since last modification

## 6. Non-Functional Requirements

| NFR | Requirement |
|-----|-------------|
| NFR-01 Latency | p50 < 3s, p95 < 8s end-to-end (Slack event to response) |
| NFR-02 Availability | 99.5% monthly uptime (internal tool SLA) |
| NFR-03 Scale | Support up to 10k NanoCorp users, 500 concurrent queries |
| NFR-04 Security | Zero cross-tenant leaks; per-user ACL enforcement; audit log integrity |
| NFR-05 Data Residency | All data processed and stored in us-west-2 |
| NFR-06 Observability | Structured JSON logs, OpenTelemetry traces, CloudWatch dashboards |

## 7. OKRs

**Objective:** Make NanoCorp's institutional knowledge instantly findable and trustworthy

| Key Result | Target | Measurement |
|------------|--------|-------------|
| KR-01 | Median answer latency < 3s | CloudWatch p50 metric |
| KR-02 | Every answer has ≥1 cited source | Automated answer validation in CI |
| KR-03 | Zero cross-space data leaks | Red-team test in qa-security gate |
| KR-04 | Stale-source warning coverage 100% | QA-data contract test |
| KR-05 | Audit log completeness >99.9% | DLQ queue depth = 0 in steady state |
| KR-06 | User adoption: 50% of employees use Almanac ≥1x/week within 30 days of launch | Slack event analytics |

## 8. Launch Criteria (Go / No-Go Gates)

| # | Gate | Owner | Pass Condition |
|---|------|-------|----------------|
| G-01 | ACL red-team | qa-security | Zero leaks across private Notion/Confluence spaces |
| G-02 | Latency SLA | eng-perf / qa | p50 < 3s, p95 < 8s on load test at 500 concurrent |
| G-03 | Audit log | qa-data | 100% of queries appear in audit log; DLQ depth 0 |
| G-04 | OAuth flow | qa | Full directory-resolve → source OAuth dance tested for all 3 connectors |
| G-05 | Stale-source | qa | Warning surfaces on every doc >90 days old |
| G-06 | Rate limiter | qa | Shared-state Redis limiter blocks at threshold; no in-memory fallback |
| G-07 | Compliance sign-off | ops-compliance | SOC 2 controls documented; GDPR data inventory complete |

## 9. Milestones

1. **Foundation** — Slack bot scaffold, WorkOS directory + OAuth, one connector (Notion), audit log pipeline
2. **Full connectors** — Confluence + Google Drive connectors, ACL filtering, stale-source logic
3. **Production hardening** — Rate limiting, DLQ, load test, red-team, compliance sign-off

## 10. Metrics & Analytics

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| p50 query latency | CloudWatch / OTel | >3s |
| p95 query latency | CloudWatch / OTel | >8s |
| Answer-with-citation rate | App metric | <95% |
| Stale-source warning rate | App metric | Monitor only |
| Audit DLQ depth | SQS metric | >0 for >5min |
| OAuth token refresh failure rate | App metric | >1% |
| Rate-limit hit rate | App metric | >5% |
