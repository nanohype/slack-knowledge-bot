/**
 * Every SQS client this service builds keeps its requests on the endpoint it
 * was configured with.
 *
 * With `useQueueUrlAsEndpoint` left at the SDK default, a client whose endpoint
 * comes from AWS_ENDPOINT_URL_SQS sends each queue call to the host in the
 * QueueUrl instead. The audit queue URLs are real AWS URLs, so a process pointed
 * at a local endpoint would send its audit traffic to AWS. These tests pin the
 * option on the factory, prove the behavior it buys, and check that the two
 * entrypoints that construct clients (src/index.ts, src/bin/audit-consumer.ts,
 * neither importable without starting the service) go through the factory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, describe, expect, it } from "vitest";
import { createSqsClient } from "./sqs-client.js";

const AWS_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/111111111111/slack-knowledge-bot-audit.fifo";
const LOCAL_ENDPOINT = "http://localhost:4566";
const ENV_KEYS = [
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_SQS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Send one message and return the origin the request was addressed to, without sending it. */
async function destinationOf(client: SQSClient): Promise<string> {
  let destination = "";
  client.middlewareStack.add(
    () => async (args) => {
      const request = args.request as { protocol: string; hostname: string; port?: number };
      destination = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}`;
      throw new Error("captured");
    },
    { step: "finalizeRequest", priority: "low" },
  );
  await expect(
    client.send(
      new SendMessageCommand({ QueueUrl: AWS_QUEUE_URL, MessageBody: "{}", MessageGroupId: "g" }),
    ),
  ).rejects.toThrow("captured");
  return destination;
}

describe("createSqsClient", () => {
  it("does not let a queue URL override the configured endpoint", () => {
    const client = createSqsClient({ region: "us-east-1", requestTimeout: 3000 });
    expect(client.config.useQueueUrlAsEndpoint).toBe(false);
  });

  it("sends to the endpoint from AWS_ENDPOINT_URL_SQS, not the queue URL's AWS host", async () => {
    process.env.AWS_ENDPOINT_URL_SQS = LOCAL_ENDPOINT;
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";

    const client = createSqsClient({ region: "us-east-1", requestTimeout: 3000 });
    expect(await destinationOf(client)).toBe(LOCAL_ENDPOINT);
  });

  it("still reaches the regional SQS host when no endpoint is configured", async () => {
    delete process.env.AWS_ENDPOINT_URL_SQS;
    delete process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";

    const client = createSqsClient({ region: "us-east-1", requestTimeout: 3000 });
    expect(await destinationOf(client)).toBe("https://sqs.us-east-1.amazonaws.com");
  });
});

describe("SQS client construction", () => {
  it("happens only in the factory, so no production client can miss the option", () => {
    const srcDir = fileURLToPath(new URL(".", import.meta.url));
    const constructs = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("vendor"))
      .filter((f) => /new\s+SQSClient\s*\(/.test(readFileSync(join(srcDir, f), "utf8")))
      .map((f) => relative(srcDir, join(srcDir, f)));
    expect(constructs).toEqual(["sqs-client.ts"]);
  });
});
