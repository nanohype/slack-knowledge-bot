import { describe, it, expect } from "vitest";
import { scrubPii } from "./pii-scrubber.js";

describe("PII Scrubber", () => {
  it("scrubs email addresses", () => {
    const result = scrubPii("Contact john.doe@nanocorp.com for help");
    expect(result).toBe("Contact [EMAIL] for help");
  });
  it("scrubs US phone numbers", () => {
    expect(scrubPii("Call 555-867-5309 for support")).toBe("Call [PHONE] for support");
  });
  it("scrubs SSN patterns", () => {
    expect(scrubPii("SSN is 123-45-6789")).toBe("SSN is [SSN]");
  });
  it("scrubs API keys", () => {
    const result = scrubPii("Use sk-abcdefghijklmnopqrstuvwxyz123456 to auth");
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result).toContain("[API_KEY]");
  });
  it("does not scrub normal business text", () => {
    const text = "What is the Q3 sales target for EMEA?";
    expect(scrubPii(text)).toBe(text);
  });
  it("handles multiple PII instances", () => {
    expect(scrubPii("Send to alice@corp.com and bob@corp.com")).toBe("Send to [EMAIL] and [EMAIL]");
  });
  it("scrubs AWS access keys (AKIA/ASIA prefix)", () => {
    expect(scrubPii("Use AKIAIOSFODNN7EXAMPLE for the migration")).toContain("[AWS_KEY]");
    expect(scrubPii("ASIAIOSFODNN7EXAMPLE is a session token")).toContain("[AWS_KEY]");
  });
  it("scrubs GitHub personal access tokens", () => {
    const pat = "ghp_" + "a".repeat(36);
    expect(scrubPii(`Token: ${pat}`)).toContain("[GITHUB_PAT]");
    expect(scrubPii(`Token: ${pat}`)).not.toContain(pat);
  });
  it("scrubs Slack bot/user/app tokens", () => {
    expect(scrubPii("xoxb-12345-67890-abcdefghij")).toContain("[SLACK_TOKEN]");
    expect(scrubPii("xoxp-something-with-token-1234567890")).toContain("[SLACK_TOKEN]");
  });
  it("scrubs JWTs (header.payload.signature)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrubPii(`Auth: ${jwt}`)).toContain("[JWT]");
    expect(scrubPii(`Auth: ${jwt}`)).not.toContain("eyJzdWIi");
  });
  it("does not scrub random 9-digit numbers (false-positive guard for SSN)", () => {
    // Non-dashed SSNs are intentionally not scrubbed; account numbers must survive.
    expect(scrubPii("Order 123456789 was shipped")).toBe("Order 123456789 was shipped");
  });
});
