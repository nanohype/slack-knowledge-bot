import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createGenerator } from "./generator.js";
import type { RetrievalHit } from "../connectors/types.js";

const bedrockMock = mockClient(BedrockRuntimeClient);

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    docId: "notion:page:p1",
    source: "notion",
    title: "Vacation Policy",
    url: "https://notion.so/p1",
    chunkText: "Employees get 15 PTO days per year.",
    lastModified: "2026-04-01T00:00:00Z",
    score: 0.9,
    accessVerified: true,
    wasRedacted: false,
    ...overrides,
  };
}

function bedrockReply(text: string): never {
  return {
    body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })),
  } as never;
}

const NOW = new Date("2026-04-15T00:00:00Z").getTime();

const BASE_DEPS = {
  bedrock: new BedrockRuntimeClient({}),
  llmModelId: "anthropic.claude-sonnet-4-6",
  staleThresholdDays: 90,
  now: () => NOW,
};

describe("createGenerator", () => {
  beforeEach(() => bedrockMock.reset());

  it("returns a graceful no-hits message when no accessible documents survive ACL", async () => {
    const generator = createGenerator(BASE_DEPS);
    const result = await generator.generate("What is our vacation policy?", [], false);
    expect(result.hasNoHits).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.answerText).toMatch(/didn't find relevant/i);
    // No Bedrock call when there's no context.
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it("distinguishes zero-hits from everything-was-redacted", async () => {
    const generator = createGenerator(BASE_DEPS);
    const result = await generator.generate(
      "anything",
      [hit({ accessVerified: false, wasRedacted: true })],
      true,
    );
    expect(result.hasNoHits).toBe(true);
    expect(result.answerText).toMatch(/accessible under your account/i);
    expect(result.hasRedactedHits).toBe(true);
  });

  it("invokes Bedrock with the configured model and returns its answer + typed citations", async () => {
    bedrockMock
      .on(InvokeModelCommand)
      .resolves(bedrockReply("Employees get 15 PTO days per year."));
    const generator = createGenerator(BASE_DEPS);
    const result = await generator.generate("PTO?", [hit()], false);

    expect(result.answerText).toBe("Employees get 15 PTO days per year.");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      source: "notion",
      docId: "notion:page:p1",
      title: "Vacation Policy",
      isStale: false,
    });

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls[0].args[0].input.modelId).toBe("anthropic.claude-sonnet-4-6");
    // InvokeModel body was passed in as a JSON string (SDK accepts Uint8Array | string),
    // so we parse directly — no decode step needed.
    const body = JSON.parse(calls[0].args[0].input.body as string);
    // The stable system prefix is sent as a content-block array with an
    // ephemeral prompt-cache breakpoint (llm-policy: caching is mandatory).
    expect(body.system).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Almanac"),
        cache_control: { type: "ephemeral" },
      },
    ]);
    // The per-query context/question turn stays after the breakpoint, uncached.
    expect(body.messages[0].content).toContain("PTO?");
    expect(body.messages[0].content).toContain("Vacation Policy");
    expect(body.messages[0]).not.toHaveProperty("content.cache_control");
  });

  it("marks a citation as stale when its lastModified exceeds the threshold", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(bedrockReply("ok"));
    const generator = createGenerator(BASE_DEPS);
    const result = await generator.generate(
      "q",
      [hit({ lastModified: "2024-01-01T00:00:00Z" })],
      false,
    );
    expect(result.citations[0].isStale).toBe(true);
  });

  it("dedupes citations by docId when the same doc appears in multiple chunks", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(bedrockReply("ok"));
    const generator = createGenerator(BASE_DEPS);
    const result = await generator.generate(
      "q",
      [hit({ docId: "d1" }), hit({ docId: "d1", chunkText: "second chunk" })],
      false,
    );
    expect(result.citations).toHaveLength(1);
  });

  it("returns a graceful error message (never throws) when Bedrock fails", async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error("throttled"));
    const generator = createGenerator(BASE_DEPS);
    const result = await generator.generate("q", [hit()], false);
    expect(result.answerText).toMatch(/trouble generating/i);
    expect(result.citations).toEqual([]);
    // hasNoHits must be false here — we had hits, we just couldn't answer.
    expect(result.hasNoHits).toBe(false);
  });
});
