import { describe, expect, it, vi } from "vitest";
import { createAclGuard } from "./acl-guard.js";
import type { RetrievalHit } from "./types.js";

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    docId: "notion:page:p1",
    source: "notion",
    title: "Onboarding",
    url: "https://notion.so/p1",
    chunkText: "welcome",
    lastModified: "2026-03-01",
    score: 0.9,
    accessVerified: false,
    wasRedacted: false,
    ...overrides,
  };
}

function stubResponse(init: ResponseInit = { status: 200 }): Response {
  return new Response("{}", {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const tokens = async () => "access-token";

describe("createAclGuard", () => {
  it("marks a hit as accessVerified when the probe returns 200", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 200 }));
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], tokens);
    expect(verified.accessVerified).toBe(true);
    expect(verified.wasRedacted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.notion.com/v1/pages/p1");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });

  it("redacts on 403 (fail-secure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 403 }));
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], tokens);
    expect(verified.accessVerified).toBe(false);
    expect(verified.wasRedacted).toBe(true);
  });

  it("redacts on 404 (fail-secure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 404 }));
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify(
      [hit({ source: "drive", docId: "drive:file:f1" })],
      tokens,
    );
    expect(verified.wasRedacted).toBe(true);
  });

  it("redacts when getAccessToken returns null (no token, no call)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], async () => null);
    expect(verified.wasRedacted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts on network error / non-HTTP failure (fail-secure)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ETIMEDOUT");
    });
    const guard = createAclGuard({ fetchImpl });
    const [verified] = await guard.verify([hit()], tokens);
    expect(verified.wasRedacted).toBe(true);
  });

  it("routes by source — a Confluence hit hits the Confluence probe URL with cloudId", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => stubResponse({ status: 200 }));
    const guard = createAclGuard({ fetchImpl });
    const cloudId = "00000000-0000-0000-0000-000000000000";
    await guard.verify([hit({ source: "confluence", docId: `confluence:${cloudId}:123` })], tokens);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/rest/api/content/123`,
    );
  });

  it("isolates per-hit outcomes — a 403 on one source doesn't poison another", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (new URL(url).hostname === "api.notion.com") return stubResponse({ status: 200 });
      return stubResponse({ status: 403 });
    });
    const guard = createAclGuard({ fetchImpl });
    const results = await guard.verify(
      [
        hit({ source: "notion", docId: "notion:page:ok" }),
        hit({ source: "drive", docId: "drive:file:denied" }),
      ],
      tokens,
    );
    expect(results[0].accessVerified).toBe(true);
    expect(results[1].wasRedacted).toBe(true);
  });

  it("circuit breaker: once tripped, subsequent probes short-circuit without invoking fetch", async () => {
    // First probe throws a network error → breaker trips (failureThreshold is 5,
    // but we emulate it with a low-threshold custom breaker config via multiple
    // failed hits instead). This test exercises the default 5-fail config by
    // forcing five network errors before the short-circuited call.
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ETIMEDOUT");
    });
    const onCounter = vi.fn();
    const guard = createAclGuard({ fetchImpl, onCounter });

    // 5 consecutive failures on the same source (notion) trip the breaker.
    for (let i = 0; i < 5; i++) {
      const [result] = await guard.verify([hit({ source: "notion" })], tokens);
      expect(result.wasRedacted).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(onCounter).toHaveBeenCalledWith("circuit.open", 1, { source: "notion" });
    expect(onCounter).toHaveBeenCalledTimes(1);

    // 6th probe: breaker is open, fetch MUST NOT be called.
    const [shortCircuited] = await guard.verify([hit({ source: "notion" })], tokens);
    expect(shortCircuited.wasRedacted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    // Other sources are unaffected — per-source breakers are independent.
    const okFetch = vi.fn<typeof fetch>(async () => stubResponse({ status: 200 }));
    const otherGuard = createAclGuard({ fetchImpl: okFetch, onCounter: vi.fn() });
    const [ok] = await otherGuard.verify([hit({ source: "drive", docId: "drive:f:1" })], tokens);
    expect(ok.accessVerified).toBe(true);
  });

  // The fail-secure default for a source nothing has registered a verifier for.
  // A hit from an unknown source cannot be checked against anything, so it must
  // be redacted — the alternative is returning content whose access was never
  // verified, which is the one outcome this guard exists to prevent. Reaching it
  // needs a source outside SUPPORTED_SOURCES, i.e. a hit the retrieval layer
  // produced from an index entry written before a connector was removed.
  it("redacts a hit whose source has no registered verifier", async () => {
    const guard = createAclGuard({ fetchImpl: vi.fn<typeof fetch>() });

    const [out] = await guard.verify(
      [hit({ source: "retired-connector" as RetrievalHit["source"], docId: "retired:doc:1" })],
      tokens,
    );

    expect(out.accessVerified).toBe(false);
    expect(out.wasRedacted).toBe(true);
  });

  // Same fail-secure rule one step later: the source is known, but no token
  // could be obtained for this user. There is nothing to probe with, so the
  // document is dropped rather than returned unverified.
  it("redacts when no access token is available for the source", async () => {
    const probe = vi.fn<typeof fetch>();
    const guard = createAclGuard({ fetchImpl: probe });

    const [out] = await guard.verify([hit()], async () => null);

    expect(out.accessVerified).toBe(false);
    expect(out.wasRedacted).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  // Tripping a breaker with no onCounter wired. The metric is optional, so the
  // guard substitutes a no-op — and the thing that must not change when the hook
  // is absent is the fail-secure behaviour: an open breaker still redacts, and
  // the missing counter must not become an exception thrown from inside the
  // breaker's onOpen callback, which would escape the guard entirely.
  it("still fails secure when a breaker opens with no counter hook wired", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ETIMEDOUT");
    });
    const guard = createAclGuard({ fetchImpl });

    for (let i = 0; i < 5; i++) {
      const [result] = await guard.verify([hit({ source: "notion" })], tokens);
      expect(result.wasRedacted).toBe(true);
    }

    // Breaker is open now — the probe is short-circuited and the hit is still
    // redacted rather than passed through unverified.
    const [afterOpen] = await guard.verify([hit({ source: "notion" })], tokens);
    expect(afterOpen.wasRedacted).toBe(true);
    expect(afterOpen.accessVerified).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
