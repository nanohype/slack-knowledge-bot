import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signOAuthStartUrl, verifyOAuthStartUrl } from "./url-token.js";

describe("oauth/url-token", () => {
  it("sign then verify round-trips the userId", () => {
    const token = signOAuthStartUrl("okta-u-1", "notion");
    expect(verifyOAuthStartUrl(token, "notion")).toBe("okta-u-1");
  });

  it("rejects a token signed for a different provider (prevents cross-provider replay)", () => {
    const token = signOAuthStartUrl("okta-u-1", "notion");
    expect(verifyOAuthStartUrl(token, "google")).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signOAuthStartUrl("okta-u-1", "notion");
    const parts = token.split(".");
    // Replace the signature with all-zeros of the same length — guaranteed
    // to differ from the real HMAC output (which is virtually never zero).
    parts[3] = "A".repeat(parts[3].length);
    expect(verifyOAuthStartUrl(parts.join("."), "notion")).toBeNull();
  });

  it("rejects a malformed token (wrong number of segments)", () => {
    expect(verifyOAuthStartUrl("not.a.valid", "notion")).toBeNull();
    expect(verifyOAuthStartUrl("way.too.many.dots.here", "notion")).toBeNull();
  });

  it("rejects an expired token", () => {
    // Build a token with exp in the past by hand.
    const pastExp = Math.floor(Date.now() / 1000) - 1;
    const payload = `okta-u-1.notion.${pastExp}`;
    const secret = "test-state-signing-secret-at-least-32-bytes-long";
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    const expired = `${payload}.${sig}`;
    expect(verifyOAuthStartUrl(expired, "notion")).toBeNull();
  });

  it("token swap attack: a signature from user A cannot authorize user B", () => {
    const tokenA = signOAuthStartUrl("okta-u-1", "notion");
    const [, provider, exp, sig] = tokenA.split(".");
    // Replace user segment only; keep provider+exp+sig.
    const forged = `okta-u-2.${provider}.${exp}.${sig}`;
    expect(verifyOAuthStartUrl(forged, "notion")).toBeNull();
  });
});
