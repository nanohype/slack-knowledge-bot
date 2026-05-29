import { describe, it, expect } from "vitest";
import {
  formatAnswer,
  formatError,
  formatOAuthPrompt,
  formatRateLimitMessage,
} from "./formatter.js";
import { SourceCitation } from "../connectors/types.js";

const fresh: SourceCitation = {
  source: "notion",
  docId: "notion:page:abc",
  title: "Q3 Sales Playbook",
  url: "https://notion.so/abc",
  lastModified: new Date(Date.now() - 30 * 86400000).toISOString(),
  isStale: false,
};
const stale: SourceCitation = {
  source: "confluence",
  docId: "confluence:page:xyz",
  title: "Old Onboarding Guide",
  url: "https://confluence.nanocorp.com/xyz",
  lastModified: new Date(Date.now() - 120 * 86400000).toISOString(),
  isStale: true,
};

describe("formatAnswer", () => {
  it("renders answer with fresh citation - no stale warning", () => {
    const result = formatAnswer("Here is the policy.", [fresh], false, false);
    const citBlock = result.blocks.find(
      (b) => b.type === "context" && JSON.stringify(b).includes("Q3 Sales Playbook"),
    );
    expect(citBlock).toBeDefined();
    expect(JSON.stringify(citBlock)).not.toContain("\u26a0");
  });
  it("renders stale warning for citations >90 days old", () => {
    const result = formatAnswer("The policy is...", [stale], false, false);
    expect(JSON.stringify(result.blocks)).toContain("\u26a0");
    expect(JSON.stringify(result.blocks)).toContain("may be outdated");
  });
  it("shows redacted notice when hasRedactedHits=true", () => {
    const result = formatAnswer("Partial answer.", [fresh], true, false);
    expect(JSON.stringify(result.blocks)).toContain("not accessible under your account");
  });
  it("does not show redacted notice when no redacted hits", () => {
    const result = formatAnswer("Full answer.", [fresh], false, false);
    expect(JSON.stringify(result.blocks)).not.toContain("not accessible");
  });
  it("includes footer on every response", () => {
    const result = formatAnswer("Answer", [fresh], false, false);
    expect(result.blocks.find((b) => JSON.stringify(b).includes("Almanac"))).toBeDefined();
  });
});

describe("formatOAuthPrompt", () => {
  it("renders one Connect button per missing source", () => {
    const links = {
      notion: "https://example/oauth/notion",
      confluence: "https://example/oauth/confluence",
      drive: "https://example/oauth/drive",
    };
    const result = formatOAuthPrompt(["notion", "confluence", "drive"], links);
    const json = JSON.stringify(result.blocks);
    expect(json).toContain("Connect Notion");
    expect(json).toContain("Connect Confluence");
    expect(json).toContain("Connect Google Drive");
    expect(json).toContain("oauth_connect_notion");
  });

  it("includes the security disclosure footer", () => {
    const result = formatOAuthPrompt(["notion"], { notion: "https://x" });
    expect(JSON.stringify(result.blocks)).toContain("encrypted and stored securely");
  });
});

describe("formatRateLimitMessage", () => {
  const NOW = 1_700_000_000_000;
  const opts = { userPerHour: 20, workspacePerHour: 500, now: () => NOW };

  it("uses the user-limit copy and the configured per-user limit", () => {
    const result = formatRateLimitMessage("user", NOW + 10 * 60_000, opts);
    expect(result.text).toMatch(/your query limit/i);
    expect(result.text).toContain("20 queries/hour");
    expect(JSON.stringify(result.blocks)).toContain("\u23f3"); // hourglass
  });

  it("uses the workspace-limit copy and the configured workspace limit", () => {
    const result = formatRateLimitMessage("workspace", NOW + 10 * 60_000, opts);
    expect(result.text).toMatch(/workspace query limit/i);
    expect(result.text).toContain("500 queries/hour");
  });

  it("renders the wait time in whole minutes (relative, timezone-free)", () => {
    const result = formatRateLimitMessage("user", NOW + 7 * 60_000, opts);
    expect(result.text).toContain("7 minutes");
    expect(result.text).not.toContain("ET");
  });

  it("floors the wait time to 1 minute even when the reset is seconds away", () => {
    const result = formatRateLimitMessage("user", NOW + 500, opts);
    expect(result.text).toContain("1 minute");
  });
});

describe("formatError", () => {
  it("includes the message and the trace ID for ops correlation", () => {
    const result = formatError("Something broke", "trace-abc-123");
    expect(result.text).toContain("Something broke");
    expect(result.text).toContain("trace-abc-123");
    expect(JSON.stringify(result.blocks)).toContain("trace-abc-123");
  });
});
