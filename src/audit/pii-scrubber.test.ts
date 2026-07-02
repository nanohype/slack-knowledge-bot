import { describe, it, expect } from 'vitest';
import { scrubPii } from './pii-scrubber.js';

/**
 * The scrubber delegates to the vendored org-wide catalog
 * (src/runtime/pii.ts), whose per-pattern unit tests live upstream in
 * nanohype library/runtime. These tests assert the app-facing contract:
 * the boundary is wired to the UNION policy — every category the
 * original app-local scrubber covered still redacts, plus the
 * categories the union added (compensation, HR/HR-case, health, DOB,
 * customer/infrastructure identifiers).
 */
describe('PII Scrubber', () => {
  it('scrubs email addresses', () => {
    const result = scrubPii('Contact john.doe@nanocorp.com for help');
    expect(result).toBe('Contact [EMAIL] for help');
  });
  it('scrubs US phone numbers', () => {
    expect(scrubPii('Call 555-867-5309 for support')).toBe('Call [PHONE] for support');
  });
  it('scrubs international phone numbers', () => {
    expect(scrubPii('mobile +44 20 7946 0958')).toBe('mobile [PHONE]');
  });
  it('scrubs SSN patterns', () => {
    expect(scrubPii('SSN is 123-45-6789')).toBe('SSN is [SSN]');
  });
  it('scrubs credit cards, including separator-grouped forms', () => {
    expect(scrubPii('visa 4111111111111111')).toBe('visa [PAYMENT]');
    expect(scrubPii('card 4111 1111 1111 1111 charged')).toBe('card [PAYMENT] charged');
  });
  it('scrubs API keys', () => {
    const result = scrubPii('Use sk-abcdefghijklmnopqrstuvwxyz123456 to auth');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result).toContain('[API_KEY]');
  });
  it('does not scrub normal business text', () => {
    const text = 'What is the Q3 sales target for EMEA?';
    expect(scrubPii(text)).toBe(text);
  });
  it('handles multiple PII instances', () => {
    expect(scrubPii('Send to alice@corp.com and bob@corp.com')).toBe('Send to [EMAIL] and [EMAIL]');
  });
  it('scrubs AWS access keys (AKIA/ASIA prefix)', () => {
    expect(scrubPii('Use AKIAIOSFODNN7EXAMPLE for the migration')).toContain('[AWS_KEY]');
    expect(scrubPii('ASIAIOSFODNN7EXAMPLE is a session token')).toContain('[AWS_KEY]');
  });
  it('scrubs GitHub personal access tokens', () => {
    const pat = 'ghp_' + 'a'.repeat(36);
    expect(scrubPii(`Token: ${pat}`)).toContain('[GITHUB_PAT]');
    expect(scrubPii(`Token: ${pat}`)).not.toContain(pat);
  });
  it('scrubs Slack bot/user/app tokens', () => {
    expect(scrubPii('xoxb-12345-67890-abcdefghij')).toContain('[SLACK_TOKEN]');
    expect(scrubPii('xoxp-something-with-token-1234567890')).toContain('[SLACK_TOKEN]');
  });
  it('scrubs JWTs (header.payload.signature)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scrubPii(`Auth: ${jwt}`)).toContain('[JWT]');
    expect(scrubPii(`Auth: ${jwt}`)).not.toContain('eyJzdWIi');
  });
  it('does not scrub random 9-digit numbers (false-positive guard for SSN)', () => {
    // Non-dashed SSNs are intentionally not scrubbed; account numbers must survive.
    expect(scrubPii('Order 123456789 was shipped')).toBe('Order 123456789 was shipped');
  });

  // ── Union categories added by the org-wide catalog ────────────────
  it('scrubs compensation figures (union policy)', () => {
    expect(scrubPii('her salary of $185,000 was approved')).toContain('[COMPENSATION]');
    expect(scrubPii('she makes 120k annually')).toContain('[COMPENSATION]');
    expect(scrubPii('discussed total comp at the offsite')).toContain('[COMPENSATION]');
  });
  it('scrubs HR / performance-case signals (union policy)', () => {
    expect(scrubPii('moved to a PIP last month')).toBe('moved to a [HR] last month');
    expect(scrubPii('on a performance improvement plan')).toContain('[HR]');
    expect(scrubPii('see HR-4821 for details')).toBe('see [HR_CASE] for details');
    // ...but not the python installer.
    expect(scrubPii('pipeline pip install')).toBe('pipeline pip install');
  });
  it('scrubs health information (union policy)', () => {
    expect(scrubPii('approved FMLA request')).toBe('approved [HEALTH] request');
    expect(scrubPii('out on medical leave')).toContain('[HEALTH]');
    expect(scrubPii('short-term disability paperwork')).toContain('[HEALTH]');
    // Benign uses survive.
    expect(scrubPii('the health of the service improved')).toBe(
      'the health of the service improved',
    );
    expect(scrubPii('please leave feedback')).toBe('please leave feedback');
  });
  it('scrubs labeled dates of birth, leaving unlabeled dates alone (union policy)', () => {
    expect(scrubPii('DOB: 01/02/1990')).toBe('[DOB]');
    expect(scrubPii('shipped on 01/02/2026')).toBe('shipped on 01/02/2026');
  });
  it('scrubs customer and infrastructure identifiers (union policy)', () => {
    expect(scrubPii('affects cust-99231 only')).toBe('affects [CUSTOMER_ID] only');
    expect(scrubPii('account_id:ac-4451 flagged')).toBe('[ACCOUNT_ID] flagged');
    expect(scrubPii('pod at 10.0.12.5 crashed')).toBe('pod at [INTERNAL_IP] crashed');
    expect(scrubPii('resolver 8.8.8.8 fine')).toBe('resolver 8.8.8.8 fine');
    expect(scrubPii('failing over db-orders-primary')).toBe('failing over [INTERNAL_HOST]');
  });
  it('scrubs street addresses (union policy)', () => {
    expect(scrubPii('lives at 742 Evergreen Way')).toBe('lives at [ADDRESS]');
  });
});
