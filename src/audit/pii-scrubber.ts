/**
 * PII scrubbing boundary for audit log entries and embeddings.
 *
 * The pattern catalog lives in the vendored org-wide runtime module
 * (`src/runtime/pii.ts` — the union of the fleet's category sets:
 * secrets/tokens, SSN/cards, compensation, HR cases, health, DOB,
 * contact info, AWS accounts, customer/infrastructure identifiers).
 * There is one org-wide PII definition; audit events here redact the
 * full union, not just the original secrets/contact subset.
 *
 * This module is the app's single scrubbing seam: audit-logger calls
 * `scrubPii` on every query string before it leaves the process
 * (SQS → DDB/S3). Where scrubbing happens is unchanged — only the
 * catalog behind it widened.
 */
import { redact } from '../runtime/pii.js';

export function scrubPii(text: string): string {
  return redact(text);
}
