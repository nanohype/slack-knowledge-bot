import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { buildQueryAuditEvent, createAuditLogger, type QueryAuditEvent } from "./audit-logger.js";

const sqsMock = mockClient(SQSClient);

function baseEvent(overrides: Partial<QueryAuditEvent> = {}): QueryAuditEvent {
  return {
    eventType: "query",
    traceId: "t-1",
    userId: "okta-1",
    slackUserId: "U1",
    channelId: "C1",
    queryHash: "deadbeef",
    scrubbedQuery: "what is the PTO policy",
    retrievedDocIds: ["d1", "d2"],
    accessibleDocIds: ["d1"],
    redactedDocCount: 1,
    answerHash: "cafebabe",
    latencyMs: 120,
    timestamp: "2026-04-15T00:00:00.000Z",
    sources: [
      {
        source: "notion",
        docId: "d1",
        url: "https://notion.so/d1",
        lastModified: "2026-04-01",
        wasStale: false,
      },
    ],
    ...overrides,
  };
}

const BASE_DEPS = {
  sqs: new SQSClient({}),
  queueUrl: "https://sqs/queue",
  dlqUrl: "https://sqs/dlq",
  now: () => new Date("2026-04-15T00:00:00.000Z").getTime(),
};

describe("createAuditLogger — emitQuery", () => {
  beforeEach(() => sqsMock.reset());

  it("emits to the primary queue with correct MessageGroupId + dedup id", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });
    const onCounter = vi.fn();
    const logger = createAuditLogger({ ...BASE_DEPS, onCounter });
    await logger.emitQuery(baseEvent());

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.QueueUrl).toBe("https://sqs/queue");
    expect(input.MessageGroupId).toBe("okta-1");
    // dedupId is sha256("okta-1|deadbeef|2026-04-15T00:00:00.000Z") —
    // SQS FIFO caps the param at 128 chars, so we hash a stable tuple.
    expect(input.MessageDeduplicationId).toBe(
      "339deb2cdf0f4fec7a0f8bab73893610d499c8e6d6bc9592a58a7353eb95c135",
    );
    expect(onCounter).not.toHaveBeenCalled();
  });

  it("re-scrubs PII in scrubbedQuery right before sending (defense in depth)", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });
    const logger = createAuditLogger(BASE_DEPS);
    await logger.emitQuery(baseEvent({ scrubbedQuery: "contact me at alice@example.com" }));
    const body = JSON.parse(
      sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody as string,
    );
    expect(body.scrubbedQuery).not.toContain("alice@example.com");
    expect(body.scrubbedQuery).toMatch(/\[EMAIL\]/);
  });

  it("falls over to the DLQ when the primary queue throws, and counts both metrics", async () => {
    sqsMock
      .on(SendMessageCommand)
      .rejectsOnce(new Error("primary down"))
      .resolvesOnce({ MessageId: "dlq-1" });
    const onCounter = vi.fn();
    const logger = createAuditLogger({ ...BASE_DEPS, onCounter });
    await logger.emitQuery(baseEvent());

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.QueueUrl).toBe("https://sqs/dlq");
    expect(onCounter).toHaveBeenCalledWith("AuditPrimaryFail");
    expect(onCounter).toHaveBeenCalledWith("AuditDLQWrite");
    expect(onCounter).not.toHaveBeenCalledWith("AuditTotalLoss");
    // DLQ payload must include the failureReason so ops can see why it got here.
    const dlqBody = JSON.parse(calls[1].args[0].input.MessageBody as string);
    expect(dlqBody.failureReason).toContain("primary down");
    // DLQ is FIFO — MessageGroupId + MessageDeduplicationId are required.
    expect(calls[1].args[0].input.MessageGroupId).toBe("okta-1");
    expect(calls[1].args[0].input.MessageDeduplicationId).toBeTruthy();
  });

  it("counts AuditTotalLoss when both primary and DLQ fail — never throws out", async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error("everything is on fire"));
    const onCounter = vi.fn();
    const logger = createAuditLogger({ ...BASE_DEPS, onCounter });
    await expect(logger.emitQuery(baseEvent())).resolves.toBeUndefined();
    expect(onCounter).toHaveBeenCalledWith("AuditPrimaryFail");
    expect(onCounter).toHaveBeenCalledWith("AuditTotalLoss");
  });
});

describe("createAuditLogger — emitRevocation", () => {
  beforeEach(() => sqsMock.reset());

  it("stamps eventType + timestamp and uses the revocation dedup id shape", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-2" });
    const logger = createAuditLogger(BASE_DEPS);
    await logger.emitRevocation({
      userId: "okta-1",
      provider: "notion",
      reason: "user",
    });
    const input = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    const body = JSON.parse(input.MessageBody as string);
    expect(body.eventType).toBe("revocation");
    expect(body.timestamp).toBe("2026-04-15T00:00:00.000Z");
    // dedupId is sha256("okta-1|notion|user|2026-04-15T00:00:00.000Z").
    expect(input.MessageDeduplicationId).toBe(
      "88a4023f6c5061ed0a544a4f745a27aee3585c70d722f6d7c73c7869e13ce9e6",
    );
  });

  it("carries the caller-supplied timestamp when one is passed", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-3" });
    const logger = createAuditLogger(BASE_DEPS);
    await logger.emitRevocation({
      userId: "okta-1",
      provider: "notion",
      reason: "offboarding",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const body = JSON.parse(
      sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody as string,
    );
    expect(body.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("buildQueryAuditEvent (pure)", () => {
  it("scrubs PII from the raw query and hashes the scrubbed form, not the raw", () => {
    const built = buildQueryAuditEvent(
      {
        traceId: "t",
        userId: "u",
        slackUserId: "s",
        channelId: "c",
        rawQuery: "contact me at alice@example.com about PTO",
        retrievedDocIds: [],
        accessibleDocIds: [],
        redactedDocCount: 0,
        answerText: "ok",
        latencyMs: 42,
        sources: [],
      },
      () => new Date("2026-04-15T00:00:00.000Z").getTime(),
    );
    expect(built.scrubbedQuery).not.toContain("alice@example.com");
    expect(built.eventType).toBe("query");
    // query hash must be deterministic on the scrubbed text.
    const again = buildQueryAuditEvent(
      {
        traceId: "t2",
        userId: "u2",
        slackUserId: "s2",
        channelId: "c2",
        rawQuery: "contact me at bob@example.com about PTO",
        retrievedDocIds: [],
        accessibleDocIds: [],
        redactedDocCount: 0,
        answerText: "ok",
        latencyMs: 0,
        sources: [],
      },
      () => new Date("2026-04-15T00:00:00.000Z").getTime(),
    );
    // Different raw PII → same scrubbed text → same hash.
    expect(built.queryHash).toBe(again.queryHash);
  });
});
