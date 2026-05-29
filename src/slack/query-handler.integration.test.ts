/**
 * Integration test for the query pipeline.
 *
 * Wires REAL module implementations with stubbed external boundaries —
 * no vi.mock of SDK packages, no vi.mock of internal modules. The
 * factories are the same ones `src/index.ts` uses in production; each
 * gets a typed fake for its external port (fake fetch, fake Redis, fake
 * RetrievalBackend, aws-sdk-client-mock for Bedrock + SQS + DDB).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SayFn, AllMiddlewareArgs } from "@slack/bolt";
import type { OAuthRouter, TokenStorage } from "almanac-oauth";
import { createRateLimiter } from "../ratelimit/redis-limiter.js";
import { createWorkOSResolver } from "../identity/workos-resolver.js";
import { createAclGuard } from "../connectors/acl-guard.js";
import { createRetriever } from "../rag/retriever.js";
import type { RetrievalBackend } from "../rag/backends/types.js";
import type { RetrievalHit } from "../connectors/types.js";
import { createGenerator } from "../rag/generator.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { createQueryHandler } from "./query-handler.js";

type BoltClient = AllMiddlewareArgs["client"];

const ddbMock = mockClient(DynamoDBClient);
const bedrockMock = mockClient(BedrockRuntimeClient);
const sqsMock = mockClient(SQSClient);

const SOURCE_TO_PROVIDER = {
  notion: "notion",
  confluence: "atlassian",
  drive: "google",
} as const;

const NOW = new Date("2026-04-15T00:00:00Z").getTime();

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function bedrockBody(payload: unknown): never {
  return { body: new TextEncoder().encode(JSON.stringify(payload)) } as never;
}

function fakeRedisUnderLimit() {
  const pipeline = {
    zremrangebyscore: () => pipeline,
    zcard: () => pipeline,
    zadd: () => pipeline,
    expire: () => pipeline,
    exec: async () =>
      [
        [null, 0],
        [null, 0],
        [null, 2],
        [null, 5],
      ] as Array<[Error | null, unknown]>,
  };
  return {
    pipeline: () => pipeline,
    get: async () => null,
    set: async () => "OK" as const,
  };
}

function fakeBackend(hits: RetrievalHit[]): RetrievalBackend {
  return {
    knnSearch: vi.fn(async () => hits),
    textSearch: vi.fn(async () => hits),
  };
}

function hit(overrides: Partial<RetrievalHit>): RetrievalHit {
  return {
    docId: "d",
    source: "notion",
    title: "",
    url: "",
    chunkText: "",
    lastModified: "2026-04-01",
    score: 0,
    accessVerified: false,
    wasRedacted: false,
    ...overrides,
  };
}

function fakeStorage(grants: Record<string, boolean>): TokenStorage {
  return {
    get: vi.fn(async (_userId: string, provider: string) =>
      grants[provider]
        ? { accessToken: "tkn", refreshToken: "rf", expiresAt: NOW + 3600_000 }
        : null,
    ),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    listProvidersForUser: vi.fn(async () => []),
  } as unknown as TokenStorage;
}

function fakeOAuth(tokens: Record<string, string | null>): OAuthRouter {
  return {
    getValidToken: vi.fn(async (_userId: string, provider: string) => tokens[provider] ?? null),
    revokeTokens: vi.fn(),
    revokeAllForUser: vi.fn(),
    handlers: {} as never,
  } as unknown as OAuthRouter;
}

function fakeBoltClient(email: string | null): BoltClient {
  return {
    users: {
      info: vi.fn(async () => ({
        user: email ? { profile: { email } } : { profile: {} },
      })),
    },
  } as unknown as BoltClient;
}

function buildDeps(overrides: {
  fetchImpl?: typeof fetch;
  redis?: ReturnType<typeof fakeRedisUnderLimit>;
  backend?: RetrievalBackend;
  oauth?: OAuthRouter;
  storage?: TokenStorage;
}) {
  const redis = overrides.redis ?? fakeRedisUnderLimit();
  const fetchImpl =
    overrides.fetchImpl ??
    (vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch);
  const backend = overrides.backend ?? fakeBackend([]);
  const storage = overrides.storage ?? fakeStorage({ notion: true, atlassian: true, google: true });
  const oauth = overrides.oauth ?? fakeOAuth({ notion: "ntkn", atlassian: "atkn", google: "gtkn" });

  const auditLogger = createAuditLogger({
    sqs: new SQSClient({}),
    queueUrl: "https://sqs/q",
    dlqUrl: "https://sqs/dlq",
    now: () => NOW,
  });
  const identityResolver = createWorkOSResolver({
    fetchImpl,
    ddbClient: new DynamoDBClient({}),
    workosApiKey: "sk_test",
    workosDirectoryId: "directory_01TEST",
    identityCacheTable: "identity-cache",
    now: () => NOW,
  });
  const rateLimiter = createRateLimiter({
    redis,
    userPerHour: 20,
    workspacePerHour: 500,
    now: () => NOW,
  });
  const retriever = createRetriever({
    backend,
    bedrock: new BedrockRuntimeClient({}),
    embeddingModelId: "titan",
  });
  const generator = createGenerator({
    bedrock: new BedrockRuntimeClient({}),
    llmModelId: "claude",
    staleThresholdDays: 90,
    now: () => NOW,
  });
  const aclGuard = createAclGuard({ fetchImpl });

  const handler = createQueryHandler({
    rateLimiter,
    identityResolver,
    retriever,
    aclGuard,
    generator,
    auditLogger,
    oauth,
    oauthStorage: storage,
    signOAuthStartUrl: (userId, provider) => `sig-${userId}-${provider}`,
    sourceToProvider: SOURCE_TO_PROVIDER,
    workspaceId: "W",
    appBaseUrl: "https://almanac.test",
    userPerHour: 20,
    workspacePerHour: 500,
    now: () => NOW,
  });
  return { handler, storage, oauth };
}

function makeSay(): { say: SayFn; calls: Parameters<SayFn>[0][] } {
  const calls: Parameters<SayFn>[0][] = [];
  const say = (async (msg: Parameters<SayFn>[0]) => {
    calls.push(msg);
    return { ok: true } as never;
  }) as SayFn;
  return { say, calls };
}

describe("query pipeline integration", () => {
  beforeEach(() => {
    ddbMock.reset();
    bedrockMock.reset();
    sqsMock.reset();
  });

  it("happy path: rate-limit allow → Slack email → directory resolve → retrieve → ACL grant → generate → audit", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        slackUserId: { S: "U1" },
        externalUserId: { S: "user-1" },
        email: { S: "u1@corp.example" },
        ttl: { N: String(Math.floor(NOW / 1000) + 600) },
      },
    });
    bedrockMock
      .on(InvokeModelCommand)
      .resolvesOnce(bedrockBody({ embedding: [0.1, 0.2] }))
      .resolvesOnce(bedrockBody({ content: [{ text: "Answer." }] }));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    const probeFetch = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    const backend = fakeBackend([
      hit({
        docId: "notion:page:p1",
        source: "notion",
        url: "https://notion.so/p1",
        title: "Vacation Policy",
        chunkText: "Employees get 15 days.",
        lastModified: "2026-04-01",
        score: 0.9,
      }),
    ]);

    const { handler } = buildDeps({ fetchImpl: probeFetch, backend });
    const { say, calls } = makeSay();
    await handler.processQuery({
      userId: "U1",
      text: "what is PTO?",
      channelId: "C1",
      say,
      client: fakeBoltClient("u1@corp.example"),
    });

    expect(calls).toHaveLength(1);
    const body = JSON.stringify(calls[0]);
    expect(body).toContain("Answer.");
    expect(body).toContain("Vacation Policy");
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it("rate-limit blocked: replies with rate-limit message and does not call downstream", async () => {
    const pipeline = {
      zremrangebyscore: () => pipeline,
      zcard: () => pipeline,
      zadd: () => pipeline,
      expire: () => pipeline,
      exec: async () =>
        [
          [null, 0],
          [null, 0],
          [null, 25],
          [null, 5],
        ] as Array<[Error | null, unknown]>,
    };
    const redis = {
      pipeline: () => pipeline,
      get: async () => null,
      set: async () => "OK" as const,
    };
    const { handler } = buildDeps({ redis });
    const { say, calls } = makeSay();

    await handler.processQuery({
      userId: "U1",
      text: "x",
      channelId: "C1",
      say,
      client: fakeBoltClient("u1@corp.example"),
    });

    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toMatch(/query limit|per hour|queries\/hour/i);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("missing Slack profile email: replies with profile-email error, no directory/retrieval", async () => {
    const { handler } = buildDeps({});
    const { say, calls } = makeSay();

    await handler.processQuery({
      userId: "U1",
      text: "x",
      channelId: "C1",
      say,
      client: fakeBoltClient(null),
    });

    expect(JSON.stringify(calls[0])).toContain("Slack profile email");
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it("identity failure: WorkOS returns no directory user, replies with identity error", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    // WorkOS auths with a Bearer API key, so there is only one outbound
    // fetch (the directory_users lookup) — no token exchange.
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const { handler } = buildDeps({ fetchImpl });
    const { say, calls } = makeSay();

    await handler.processQuery({
      userId: "U1",
      text: "x",
      channelId: "C1",
      say,
      client: fakeBoltClient("nobody@corp.example"),
    });

    expect(JSON.stringify(calls[0])).toContain("linked to your workforce directory");
  });

  it("all OAuth tokens missing: replies with OAuth prompt containing a signed link per source", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        slackUserId: { S: "U1" },
        externalUserId: { S: "user-1" },
        email: { S: "u1@corp.example" },
        ttl: { N: String(Math.floor(NOW / 1000) + 600) },
      },
    });
    const storage = fakeStorage({});
    const { handler } = buildDeps({ storage });
    const { say, calls } = makeSay();

    await handler.processQuery({
      userId: "U1",
      text: "x",
      channelId: "C1",
      say,
      client: fakeBoltClient("u1@corp.example"),
    });

    const body = JSON.stringify(calls[0]);
    expect(body).toContain("t=sig-user-1-notion");
    expect(body).toContain("t=sig-user-1-atlassian");
    expect(body).toContain("t=sig-user-1-google");
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it("ACL redaction: a 403 on one source produces a redaction notice but the answer still emits", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        slackUserId: { S: "U1" },
        externalUserId: { S: "user-1" },
        email: { S: "u1@corp.example" },
        ttl: { N: String(Math.floor(NOW / 1000) + 600) },
      },
    });
    bedrockMock
      .on(InvokeModelCommand)
      .resolvesOnce(bedrockBody({ embedding: [0.1] }))
      .resolvesOnce(bedrockBody({ content: [{ text: "ok" }] }));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    const probeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.notion.com")) return jsonResponse({ ok: true }, { status: 200 });
      return jsonResponse({}, { status: 403 });
    }) as unknown as typeof fetch;

    const backend = fakeBackend([
      hit({
        docId: "notion:page:a",
        source: "notion",
        url: "https://notion.so/a",
        title: "A",
        chunkText: "x",
        lastModified: "2026-04-01",
      }),
      hit({
        docId: "drive:file:b",
        source: "drive",
        url: "https://d/b",
        title: "B",
        chunkText: "y",
        lastModified: "2026-04-02",
      }),
    ]);

    const { handler } = buildDeps({ fetchImpl: probeFetch, backend });
    const { say, calls } = makeSay();
    await handler.processQuery({
      userId: "U1",
      text: "what?",
      channelId: "C1",
      say,
      client: fakeBoltClient("u1@corp.example"),
    });

    const body = JSON.stringify(calls[0]);
    expect(body).toMatch(/couldn't access|redacted|not accessible/i);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });
});
