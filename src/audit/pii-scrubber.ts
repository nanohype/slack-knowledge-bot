/**
 * PII scrubber for audit log entries and embeddings.
 *
 * Patterns are ordered most-specific first so longer matches win over
 * shorter ones (e.g., AKIA access keys before generic API key prefixes).
 *
 * Non-dashed SSN (`\b\d{9}\b`) is intentionally NOT scrubbed: it
 * collides with legitimate 9-digit account numbers and would produce
 * unacceptable false positives in business text. If we ever need it,
 * use a context-aware detector (label + value), not raw regex.
 */

interface ScrubPattern {
  label: string;
  pattern: RegExp;
  replacement: string;
}

const SCRUB_PATTERNS: ScrubPattern[] = [
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[JWT]",
  },
  {
    label: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[AWS_KEY]",
  },
  {
    label: "github_pat",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g,
    replacement: "[GITHUB_PAT]",
  },
  {
    label: "slack_token",
    pattern: /\bxox[bpasr]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[SLACK_TOKEN]",
  },
  {
    label: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: "[EMAIL]",
  },
  {
    label: "phone_us",
    pattern: /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
    replacement: "[PHONE]",
  },
  {
    label: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN]",
  },
  {
    label: "credit_card",
    pattern:
      /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    replacement: "[PAYMENT]",
  },
  {
    label: "aws_account_id",
    pattern: /\b\d{12}\b(?=\s*(?:aws|account))/gi,
    replacement: "[AWS_ACCOUNT]",
  },
  {
    label: "api_key_generic",
    pattern: /\b(?:sk-|pk_live_|Bearer\s)[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[API_KEY]",
  },
];

export function scrubPii(text: string): string {
  let scrubbed = text;
  for (const { pattern, replacement } of SCRUB_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

export function scrubPiiFromObject<T extends Record<string, unknown>>(
  obj: T,
  fields: (keyof T)[],
): T {
  const scrubbed = { ...obj };
  for (const field of fields) {
    if (typeof scrubbed[field] === "string") {
      (scrubbed as Record<string, unknown>)[field as string] = scrubPii(scrubbed[field] as string);
    }
  }
  return scrubbed;
}
