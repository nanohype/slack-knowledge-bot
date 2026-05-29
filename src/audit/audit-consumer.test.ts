import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { runAuditConsumer, type AuditConsumerDeps } from "./audit-consumer.js";

const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBClient);
const s3Mock = mockClient(S3Client);

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: "query",
    userId: "okta-1",
    timestamp: "2026-04-15T00:00:00.000Z",
    queryHash: "deadbeef",
    ...overrides,
  });
}

function message(body: string, id = "m-1", receipt = "r-1"): Message {
  return { MessageId: id, Body: body, ReceiptHandle: receipt };
}

/**
 * Build a stop-after-N-receives controller. The consumer's loop calls
 * `shouldStop()` once at the top of each iteration; we want it to allow
 * exactly one ReceiveMessage round before exiting.
 */
function stopAfter(n: number): () => boolean {
  let receives = 0;
  return () => {
    if (receives >= n) return true;
    receives += 1;
    return false;
  };
}

function makeDeps(overrides: Partial<AuditConsumerDeps> = {}): AuditConsumerDeps {
  return {
    sqs: new SQSClient({}),
    ddb: new DynamoDBClient({}),
    s3: new S3Client({}),
    queueUrl: "https://sqs/audit",
    auditTable: "almanac-audit",
    auditBucket: "almanac-audit-archive",
    shouldStop: stopAfter(1),
    ...overrides,
  };
}

beforeEach(() => {
  sqsMock.reset();
  ddbMock.reset();
  s3Mock.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));
});

describe("runAuditConsumer — happy path", () => {
  it("writes the message to DDB + S3, deletes it, counts ok", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message(validBody())] });
    sqsMock.on(DeleteMessageCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    const ddbCalls = ddbMock.commandCalls(PutItemCommand);
    expect(ddbCalls).toHaveLength(1);
    const ddbInput = ddbCalls[0].args[0].input;
    expect(ddbInput.TableName).toBe("almanac-audit");
    expect(ddbInput.Item?.userId).toEqual({ S: "okta-1" });
    expect(ddbInput.Item?.timestamp).toEqual({ S: "2026-04-15T00:00:00.000Z" });
    expect(ddbInput.Item?.eventData?.S).toBe(validBody());
    // TTL = floor(now/1000) + 90d in seconds = 1776211200 + 7776000 = 1783987200
    expect(ddbInput.Item?.ttl).toEqual({ N: "1783987200" });

    const s3Calls = s3Mock.commandCalls(PutObjectCommand);
    expect(s3Calls).toHaveLength(1);
    const s3Input = s3Calls[0].args[0].input;
    expect(s3Input.Bucket).toBe("almanac-audit-archive");
    // key = audit/<userId>/<datePart>/<queryHash>.json
    expect(s3Input.Key).toBe("audit/okta-1/2026-04-15/deadbeef.json");
    expect(s3Input.Body).toBe(validBody());
    expect(s3Input.ContentType).toBe("application/json");

    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
    expect(onProcessed).toHaveBeenCalledWith("ok");
  });

  it("processes a batch of messages concurrently and deletes each on success", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        message(validBody({ userId: "u-1" }), "m-1", "r-1"),
        message(validBody({ userId: "u-2" }), "m-2", "r-2"),
        message(validBody({ userId: "u-3" }), "m-3", "r-3"),
      ],
    });
    sqsMock.on(DeleteMessageCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(3);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(3);
    const deletes = sqsMock.commandCalls(DeleteMessageCommand);
    expect(deletes).toHaveLength(3);
    expect(new Set(deletes.map((c) => c.args[0].input.ReceiptHandle))).toEqual(
      new Set(["r-1", "r-2", "r-3"]),
    );
    expect(onProcessed).toHaveBeenCalledTimes(3);
    expect(onProcessed.mock.calls.every(([outcome]) => outcome === "ok")).toBe(true);
  });
});

describe("runAuditConsumer — drop paths (poison messages)", () => {
  it("drops malformed JSON: deletes from queue, no DDB/S3 write, counts dropped_malformed", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message("{ not valid json")] });
    sqsMock.on(DeleteMessageCommand).resolves({});
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
    expect(onProcessed).toHaveBeenCalledWith("dropped_malformed");
  });

  it.each([
    ["missing userId", { userId: undefined }],
    ["bad userId chars (space)", { userId: "okta 1" }],
    ["bad userId chars (slash)", { userId: "okta/1" }],
    ["userId too long", { userId: "x".repeat(129) }],
    ["missing timestamp", { timestamp: undefined }],
    ["timestamp without date part", { timestamp: "not-a-date" }],
    ["timestamp with bad date shape", { timestamp: "2026/04/15T00:00:00.000Z" }],
    ["missing queryHash", { queryHash: undefined }],
    ["queryHash with non-alphanumeric chars", { queryHash: "dead-beef" }],
    ["queryHash too long", { queryHash: "a".repeat(129) }],
  ])(
    "drops invalid shape (%s): deletes from queue, no DDB/S3 write, counts dropped_invalid_shape",
    async (_label, override) => {
      sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message(validBody(override))] });
      sqsMock.on(DeleteMessageCommand).resolves({});
      const onProcessed = vi.fn();

      await runAuditConsumer(makeDeps({ onProcessed }));

      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
      expect(onProcessed).toHaveBeenCalledWith("dropped_invalid_shape");
    },
  );

  it("rejects a JSON null body as invalid shape", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message("null")] });
    sqsMock.on(DeleteMessageCommand).resolves({});
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    expect(onProcessed).toHaveBeenCalledWith("dropped_invalid_shape");
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });

  it("skips a message that arrived without a receipt handle (defensive)", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: "m-1", Body: validBody() } as Message],
    });
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(onProcessed).not.toHaveBeenCalled();
  });
});

describe("runAuditConsumer — retry path (transient write errors)", () => {
  it("does NOT delete when DDB write throws, counts retry — SQS will reappear it", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message(validBody())] });
    ddbMock.on(PutItemCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    s3Mock.on(PutObjectCommand).resolves({});
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(onProcessed).toHaveBeenCalledWith("retry");
  });

  it("does NOT delete when S3 write throws after DDB succeeds — at-least-once semantics tolerate the DDB replay", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [message(validBody())] });
    ddbMock.on(PutItemCommand).resolves({});
    s3Mock.on(PutObjectCommand).rejects(new Error("S3 5xx"));
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(onProcessed).toHaveBeenCalledWith("retry");
  });
});

describe("runAuditConsumer — loop control", () => {
  it("exits the loop when shouldStop() returns true", async () => {
    const shouldStop = vi.fn().mockReturnValue(true);
    await runAuditConsumer(makeDeps({ shouldStop }));
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
  });

  it("continues looping when a receive batch is empty", async () => {
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [] })
      .resolves({ Messages: [message(validBody())] });
    sqsMock.on(DeleteMessageCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});

    await runAuditConsumer(makeDeps({ shouldStop: stopAfter(2) }));

    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it("backs off and continues when ReceiveMessage throws", async () => {
    sqsMock
      .on(ReceiveMessageCommand)
      .rejectsOnce(new Error("transient network"))
      .resolves({ Messages: [message(validBody())] });
    sqsMock.on(DeleteMessageCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});
    const log = vi.fn();

    const run = runAuditConsumer(makeDeps({ shouldStop: stopAfter(2), log }));
    // Drain the 1s backoff timer.
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "error",
      "audit-consumer: receive failed, backing off",
      expect.any(Object),
    );
  });

  it("uses long-poll receive params: max 10 messages, 20s wait, 60s visibility", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });

    await runAuditConsumer(makeDeps({ shouldStop: stopAfter(1) }));

    const calls = sqsMock.commandCalls(ReceiveMessageCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.QueueUrl).toBe("https://sqs/audit");
    expect(input.MaxNumberOfMessages).toBe(10);
    expect(input.WaitTimeSeconds).toBe(20);
    expect(input.VisibilityTimeout).toBe(60);
  });
});

describe("runAuditConsumer — batch isolation", () => {
  it("one message's retry does not block sibling messages from being deleted", async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        message(validBody({ userId: "u-ok" }), "m-ok", "r-ok"),
        message(validBody({ userId: "u-fail" }), "m-fail", "r-fail"),
      ],
    });
    sqsMock.on(DeleteMessageCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock
      .on(PutItemCommand, { Item: { userId: { S: "u-ok" } } satisfies Record<string, unknown> })
      .resolves({})
      .on(PutItemCommand, { Item: { userId: { S: "u-fail" } } satisfies Record<string, unknown> })
      .rejects(new Error("throttle"));
    const onProcessed = vi.fn();

    await runAuditConsumer(makeDeps({ onProcessed }));

    const deletes = sqsMock.commandCalls(DeleteMessageCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input.ReceiptHandle).toBe("r-ok");
    expect(onProcessed).toHaveBeenCalledWith("ok");
    expect(onProcessed).toHaveBeenCalledWith("retry");
  });
});
