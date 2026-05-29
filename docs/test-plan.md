# Almanac — Test Plan
**Author:** tech-writer / qa  
**Date:** 2025-01

---

## 1. Test Strategy

### Scope
- Unit tests: ACL guard, PII scrubber, rate limiter, formatter, token store
- Integration tests: Connector crawlers, audit pipeline, OAuth flow
- E2E tests: Full query pipeline (staging environment)
- Security tests: Red-team ACL, prompt injection, audit completeness
- Performance tests: Load test at 500 concurrent queries

### Test Stack
- Unit/Integration: Jest + ts-jest
- E2E: Custom Slack bot test harness against staging
- Load: k6
- Security: Manual red-team + automated OWASP ZAP scan

---

## 2. Unit Test Coverage

### Critical test files

| File | Tests | Coverage Target |
|------|-------|----------------|
| `tests/acl-guard.test.ts` | ACL grant, ACL redact (403), missing token, network timeout, multi-source | 100% branch |
| `tests/pii-scrubber.test.ts` | Email, phone, SSN, credit card, API keys, no false positives | 100% |
| `tests/rate-limiter.test.ts` | Under limit, user limit exceeded, workspace limit exceeded, Redis down (fail open) | 100% |
| `tests/formatter.test.ts` | Fresh citation, stale citation, redacted notice, no-hits, footer | 95% |

### Run unit tests
```bash
npm test                    # All tests
npm test -- --watch         # Watch mode
npm test -- --coverage      # With coverage report
npm test -- tests/acl-guard # Single file
```

---

## 3. Integration Tests

### IT-01: OAuth Token Store Round-Trip
```
1. Call storeTokens(userId, { notionAccessToken: "test-token" })
2. Call getTokens(userId)
3. Assert: returned tokens match input
4. Assert: DDB row contains encryptedPayload (not plaintext token)
5. Assert: KMS decrypt succeeds with correct encryption context
6. Assert: KMS decrypt fails with wrong encryption context
```

### IT-02: Audit Event End-to-End
```
1. Emit audit event via emitAuditEvent()
2. Poll SQS for message receipt (within 5s)
3. Trigger Lambda manually or wait for SQS trigger
4. Assert: DDB audit table contains the event
5. Assert: S3 audit bucket contains the event JSON
6. Assert: scrubbedQuery field does not contain email/phone/SSN
```

### IT-03: Rate Limiter Shared State
```
1. Spin up 2 instances of the app (Docker Compose)
2. Send 10 queries from instance 1 (userId: test-user)
3. Send 10 queries from instance 2 (userId: test-user)
4. Send 1 more query from either instance
5. Assert: Query 21 is rate-limited (HTTP 429 or rate-limit message)
6. Assert: Redis key ratelimit:user:test-user has count = 20
```

### IT-04: Stale-Source Warning
```
1. Index a test doc with last_modified = 100 days ago
2. Query @almanac for content known to match that doc
3. Assert: Response contains "⚠️" stale indicator
4. Assert: Response shows approximate last-modified date
```

---

## 4. E2E Tests (Staging)

### E2E-01: Happy Path — Single Source Query
```
Environment: Staging Slack workspace
Setup: Test user has Notion access; test page "E2E Test Doc" exists in Notion
Test: Send "@almanac what does E2E Test Doc say?"
Expected:
  - Response received within 8s
  - Response contains answer text
  - Response contains citation for the Notion page URL
  - Response contains last-modified timestamp
```

### E2E-02: Cross-User ACL Isolation
```
Environment: Staging
Setup: 
  - Private Notion page "Confidential E2E Test" exists (accessible to Admin, not test user)
  - Test user does NOT have access
Test: Test user asks "@almanac what is in Confidential E2E Test?"
Expected:
  - Response does NOT contain content from that page
  - Response may contain "I found content I can't access for you"
```

### E2E-03: Multi-Source Answer
```
Environment: Staging
Setup: Question is answerable with content spread across Notion + Confluence
Test: Ask question that spans both sources
Expected:
  - Response contains citations from both Notion AND Confluence
  - Both citations have valid URLs
```

### E2E-04: OAuth Re-Auth Flow
```
Environment: Staging
Setup: Delete test user's tokens from DDB
Test: Ask any question
Expected:
  - Almanac sends DM with OAuth re-authorization buttons
  - Buttons link to correct OAuth start URLs
  - After re-auth, original question can be answered
```

---

## 5. Security Tests

### ST-01 through ST-06
See `artifacts/qa-security/almanac-threat-model.md` — Red-Team Test Cases RT-01 through RT-06.

These must all pass before production launch.

---

## 6. Performance Tests

### PT-01: Baseline Latency
```
Tool: k6
Profile: 10 concurrent users, 60s duration
Target: p50 < 3s, p95 < 8s
Script: k6-scripts/baseline.js
```

### PT-02: Peak Load
```
Tool: k6
Profile: 500 concurrent users, 120s duration
Target: p50 < 3s, p95 < 8s, error rate < 1%
Script: k6-scripts/peak-load.js
```

### k6 Script Template
```javascript
// k6-scripts/baseline.js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 10,
  duration: "60s",
  thresholds: {
    http_req_duration: ["p(50)<3000", "p(95)<8000"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  // Simulate @almanac mention via Slack Events API test endpoint
  const res = http.post(
    `${__ENV.ALMANAC_STAGING_URL}/slack/test-query`,
    JSON.stringify({
      user_id: `test_user_${__VU}`,
      text: "What is the vacation policy?",
      channel_id: "C_TEST",
    }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, {
    "status is 200": (r) => r.status === 200,
    "has citations": (r) => JSON.parse(r.body).citations?.length > 0,
  });
  sleep(1);
}
```

---

## 7. Launch Gate Summary

All of the following must pass before production deployment:

| Gate | Test | Owner | Status |
|------|------|-------|--------|
| G-01 | Red-team RT-01 (ACL leak) | qa-security | 🔲 |
| G-02 | Red-team RT-02 (Confluence isolation) | qa-security | 🔲 |
| G-03 | Load test PT-02 (500 concurrent, p50 < 3s) | qa / eng-perf | 🔲 |
| G-04 | Audit completeness E2E (IT-02, DLQ = 0) | qa-data | 🔲 |
| G-05 | OAuth flow E2E-04 | qa | 🔲 |
| G-06 | Rate limiter shared state IT-03 | qa | 🔲 |
| G-07 | Compliance checklist | ops-compliance | 🔲 |
| G-08 | Security findings (FINDING-01, -02, -03) | qa-security | 🔲 |
| G-09 | npm audit 0 HIGH/CRITICAL | eng-devex | 🔲 |
| G-10 | ECR scan 0 HIGH/CRITICAL | eng-infra | 🔲 |
