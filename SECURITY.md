# Security Policy

## Reporting a vulnerability

Email rackctl@gmail.com with subject `[security][slack-knowledge-bot]`. Do not open public issues for security reports.

Acknowledgement target: within 72 hours. Triage target: within 5 business days.

## Security posture

slack-knowledge-bot answers employee questions over company knowledge sources, so its
defining control is that **no query ever sees more than the asking user could see anyway**.

### Per-user access control

- Retrieval ranks candidate documents from a shared index, then verifies every hit against
  **the asking user's own OAuth tokens** in the source system (Notion / Confluence / Drive)
  before it reaches the model. There is no shared service-account view of company knowledge.
- The ACL check is **fail-secure**: a missing token, a 403/404, a timeout, a network error,
  or an open circuit breaker all drop the document from results. A user only ever sees an
  answer grounded in documents they can already open.
- `/slack-knowledge-bot disconnect [source|all]` lets a user revoke the bot's delegated access to their
  own accounts at any time; revocations flow through the audit pipeline.

### Identity & secrets

- No long-lived credentials in the app. Pods get AWS access via IRSA (Workload Identity);
  there are no static keys anywhere in the repo or image.
- Per-user OAuth tokens are stored in DynamoDB under **KMS envelope encryption**, never in
  Secrets Manager (per-user secrets would cost orders of magnitude more at scale).
- App-level secrets are projected at deploy time by External Secrets Operator from AWS
  Secrets Manager (`slack-knowledge-bot/<env>/*`) into a Kubernetes Secret — never committed.
- Identity is resolved Slack user → workforce user via WorkOS Directory Sync; the bot acts
  only on behalf of a resolved, directory-known user.

### Data handling & audit

- A PII scrubber removes email / phone / SSN / credit-card / AWS-account / GitHub-PAT /
  Slack-token / JWT / API-key patterns at the audit boundary before anything is persisted.
- Every query is written to an at-least-once audit pipeline (SQS → consumer → DynamoDB with
  a 90-day TTL + S3 with a 1-year lifecycle). Audit loss is alerted on (`AuditTotalLoss`,
  `AuditDlqDepth`).
- Inference runs on-account via Amazon Bedrock — source content is not sent to third parties.

### Network

- Default-deny `NetworkPolicy` with an explicit egress allow-list (AWS APIs, the Slack /
  WorkOS / Notion / Confluence / Drive HTTPS endpoints, and RDS + Redis on the cluster VPC
  CIDR). IMDS is blocked.
- Public surface is limited to `/health` and the OAuth `/start` + `/callback` routes behind
  ingress-nginx + cert-manager TLS.

## Known limitations

- ACL freshness is bounded by the source systems' own token/permission propagation — a
  permission revoked upstream is enforced on the next query, not retroactively on a
  cached answer.
- The retrieval index is shared across users; isolation is enforced at the post-retrieval
  ACL check, not by per-user indexes. A bug in a connector verifier is therefore a
  fail-secure concern — hence the grep-enforced no-`vi.mock`(SDK) test rule and the
  acl-guard coverage floor.

## Compliance

slack-knowledge-bot exposes the controls needed for **SOC 2 Type II** — encrypted-at-rest
token store (KMS) and audit log, a complete per-query audit trail, IRSA-only access with no
static credentials, and PII scrubbing at the persistence boundary. Substrate-level controls
(CIS EKS baseline, Pod Security Standards, image signing) are enforced upstream by
`landing-zone` and `eks-gitops`.
