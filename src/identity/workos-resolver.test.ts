import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createWorkOSResolver, type WorkOSResolverConfig } from "./workos-resolver.js";

const ddbMock = mockClient(DynamoDBClient);

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const NOW_MS = 1_700_000_000_000;

const BASE_DEPS: Omit<WorkOSResolverConfig, "fetchImpl" | "ddbClient"> = {
  workosApiKey: "sk_test_abc",
  workosDirectoryId: "directory_01HNK",
  identityCacheTable: "identity-cache",
  now: () => NOW_MS,
};

describe("createWorkOSResolver", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("returns the DDB-cached identity when TTL hasn't expired, skipping WorkOS", async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        slackUserId: { S: "U1" },
        externalUserId: { S: "directory_user_01ABC" },
        email: { S: "u1@example.com" },
        ttl: { N: String(nowSec + 600) },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    const identity = await resolver.resolveSlackToExternal("U1", "u1@example.com");

    expect(identity).toEqual({
      externalUserId: "directory_user_01ABC",
      email: "u1@example.com",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("on cache miss lists the directory with Bearer auth and filters by email client-side", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          { id: "directory_user_01BOB", email: "bob@example.com", emails: [] },
          { id: "directory_user_01ADA", email: "ada@example.com", emails: [] },
        ],
        list_metadata: { after: null },
      }),
    );
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    const identity = await resolver.resolveSlackToExternal("U9", "ada@example.com");

    expect(identity).toEqual({
      externalUserId: "directory_user_01ADA",
      email: "ada@example.com",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0];
    const parsed = new URL(String(calledUrl));
    expect(parsed.origin + parsed.pathname).toBe("https://api.workos.com/directory_users");
    expect(parsed.searchParams.get("directory")).toBe("directory_01HNK");
    // No `email` param — WorkOS rejects that with 422. Client-side filter instead.
    expect(parsed.searchParams.has("email")).toBe(false);
    expect(parsed.searchParams.get("limit")).toBe("100");
    expect((calledInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk_test_abc",
    );
  });

  it("writes the resolved identity back to the DDB cache", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: "directory_user_01GRACE",
            emails: [{ primary: true, value: "grace@example.com" }],
          },
        ],
      }),
    );
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    await resolver.resolveSlackToExternal("U_GRACE", "grace@example.com");

    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.Item).toMatchObject({
      slackUserId: { S: "U_GRACE" },
      externalUserId: { S: "directory_user_01GRACE" },
      email: { S: "grace@example.com" },
    });
  });

  it("picks the primary email from a multi-email user", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: "directory_user_01LOVELACE",
            emails: [
              { primary: false, value: "ada.personal@example.com" },
              { primary: true, value: "ada@corp.example" },
            ],
          },
        ],
      }),
    );
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    const identity = await resolver.resolveSlackToExternal("U1", "ada@corp.example");
    expect(identity?.email).toBe("ada@corp.example");
  });

  it("returns null when WorkOS returns an empty data array (no matching directory user)", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    const identity = await resolver.resolveSlackToExternal("U_UNKNOWN", "nobody@example.com");

    expect(identity).toBeNull();
    // Must not have cached a null lookup.
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it("returns null and logs when WorkOS responds non-2xx (never throws out)", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    );
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    const identity = await resolver.resolveSlackToExternal("U1", "u1@example.com");
    expect(identity).toBeNull();
  });

  it("honours a custom baseUrl (useful for VCR-style fixtures + local WorkOS sandbox)", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: "directory_user_01SANDBOX",
            emails: [{ primary: true, value: "a@example.com" }],
          },
        ],
      }),
    );
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
      baseUrl: "https://sandbox.workos.local",
    });

    await resolver.resolveSlackToExternal("U1", "a@example.com");
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url.startsWith("https://sandbox.workos.local/directory_users?")).toBe(true);
  });

  it("paginates via `after` cursor until the email matches", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const after = url.searchParams.get("after");
      if (!after) {
        return jsonResponse({
          data: [{ id: "directory_user_01ALICE", email: "alice@example.com" }],
          list_metadata: { after: "cursor-1" },
        });
      }
      if (after === "cursor-1") {
        return jsonResponse({
          data: [{ id: "directory_user_01CAROL", email: "carol@example.com" }],
          list_metadata: { after: null },
        });
      }
      throw new Error(`unexpected after cursor: ${after}`);
    });
    const resolver = createWorkOSResolver({
      ...BASE_DEPS,
      fetchImpl,
      ddbClient: new DynamoDBClient({}),
    });

    const identity = await resolver.resolveSlackToExternal("U_CAROL", "carol@example.com");

    expect(identity).toEqual({
      externalUserId: "directory_user_01CAROL",
      email: "carol@example.com",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
