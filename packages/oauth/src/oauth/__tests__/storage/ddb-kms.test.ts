import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DDBKmsTokenStorage } from "../../storage/ddb-kms.js";

const ddbMock = mockClient(DynamoDBClient);
const kmsMock = mockClient(KMSClient);

const TABLE = "oauth-tokens";
const KEY_ID = "alias/oauth-tokens";

function makeStorage(): DDBKmsTokenStorage {
  return new DDBKmsTokenStorage({
    tableName: TABLE,
    keyId: KEY_ID,
    ddbClient: new DynamoDBClient({}),
    kmsClient: new KMSClient({}),
  });
}

describe("DDBKmsTokenStorage (envelope encryption)", () => {
  beforeEach(() => {
    ddbMock.reset();
    kmsMock.reset();
  });

  afterEach(() => {
    ddbMock.reset();
    kmsMock.reset();
  });

  it("put requests a data key from KMS with EncryptionContext and stores an envelope frame", async () => {
    const plainKey = randomBytes(32);
    const wrappedKey = Buffer.from("wrapped-key-ciphertext-bytes");
    kmsMock.on(GenerateDataKeyCommand).resolves({
      Plaintext: plainKey,
      CiphertextBlob: wrappedKey,
    });
    ddbMock.on(PutItemCommand).resolves({});

    const storage = makeStorage();
    await storage.put("user-abc", "notion", { accessToken: "A", refreshToken: "R" });

    const genCalls = kmsMock.commandCalls(GenerateDataKeyCommand);
    expect(genCalls).toHaveLength(1);
    expect(genCalls[0].args[0].input.KeyId).toBe(KEY_ID);
    expect(genCalls[0].args[0].input.KeySpec).toBe("AES_256");
    expect(genCalls[0].args[0].input.EncryptionContext).toEqual({
      purpose: "oauth-token",
      userId: "user-abc",
      provider: "notion",
    });

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const stored = putCalls[0].args[0].input.Item?.ciphertext?.B as Buffer;
    // Frame starts with version byte 0x01, then 2-byte BE length = wrappedKey.length.
    expect(stored[0]).toBe(0x01);
    expect(stored.readUInt16BE(1)).toBe(wrappedKey.length);
    // And the wrapped key bytes follow immediately.
    expect(stored.subarray(3, 3 + wrappedKey.length)).toEqual(wrappedKey);
  });

  it("put → get round-trips a large payload that would exceed the 4KB KMS plaintext limit", async () => {
    // Generate a 8 KB grant (well over the raw KMS.Encrypt cap) — simulates
    // Atlassian's token response with access + refresh + scopes +
    // accessible_resources.
    const big = "x".repeat(8 * 1024);
    const grant = { accessToken: big, refreshToken: "R", raw: { scope: big } };

    const plainKey = randomBytes(32);
    const wrappedKey = Buffer.from("wrapped-key-ciphertext-bytes");

    kmsMock.on(GenerateDataKeyCommand).resolves({
      Plaintext: plainKey,
      CiphertextBlob: wrappedKey,
    });

    // Capture the frame written by put, feed it back to get, and assert
    // the unwrap-and-decrypt round-trips the original payload.
    let storedFrame: Buffer | null = null;
    ddbMock.on(PutItemCommand).callsFake((input) => {
      storedFrame = input.Item.ciphertext.B as Buffer;
      return {};
    });

    const storage = makeStorage();
    await storage.put("user-abc", "atlassian", grant);
    expect(storedFrame).not.toBeNull();

    ddbMock.on(GetItemCommand).resolves({
      Item: {
        userId: { S: "user-abc" },
        provider: { S: "atlassian" },
        ciphertext: { B: storedFrame! },
      },
    });
    // On decrypt KMS just returns the same plaintext key (mock of the
    // unwrap step); AES-GCM then runs over the frame client-side.
    kmsMock.on(DecryptCommand).resolves({ Plaintext: plainKey });

    const decoded = await storage.get("user-abc", "atlassian");
    expect(decoded).toEqual(grant);

    const decryptCalls = kmsMock.commandCalls(DecryptCommand);
    expect(decryptCalls).toHaveLength(1);
    expect(decryptCalls[0].args[0].input.EncryptionContext).toEqual({
      purpose: "oauth-token",
      userId: "user-abc",
      provider: "atlassian",
    });
    // Unwrap target was exactly the wrapped-key bytes from the frame.
    expect(decryptCalls[0].args[0].input.CiphertextBlob).toEqual(wrappedKey);
  });

  it("get returns null when the item is missing", async () => {
    ddbMock.on(GetItemCommand).resolves({});
    const storage = makeStorage();
    expect(await storage.get("u", "notion")).toBeNull();
  });

  it("delete issues a DeleteItemCommand with composite key", async () => {
    ddbMock.on(DeleteItemCommand).resolves({});
    const storage = makeStorage();
    await storage.delete("user-abc", "notion");

    const calls = ddbMock.commandCalls(DeleteItemCommand);
    expect(calls).toHaveLength(1);
    const key = calls[0].args[0].input.Key!;
    expect(key.userId).toEqual({ S: "user-abc" });
    expect(key.provider).toEqual({ S: "notion" });
  });

  it("deleteAllForUser queries by userId PK then deletes each provider row", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { userId: { S: "u" }, provider: { S: "notion" } },
        { userId: { S: "u" }, provider: { S: "google" } },
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(DeleteItemCommand).resolves({});

    const storage = makeStorage();
    await storage.deleteAllForUser("u");

    const deleteCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(deleteCalls).toHaveLength(2);
    const providers = deleteCalls.map((c) => c.args[0].input.Key!.provider as { S: string });
    expect(providers.map((p) => p.S).sort()).toEqual(["google", "notion"]);
  });

  it("rejects when KMS GenerateDataKey returns no key material", async () => {
    kmsMock.on(GenerateDataKeyCommand).resolves({});
    const storage = makeStorage();
    await expect(storage.put("u", "notion", { accessToken: "A" })).rejects.toThrow(
      /no key material/,
    );
  });

  it("rejects when stored blob isn't a v1 envelope frame (old direct-KMS ciphertexts)", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        userId: { S: "u" },
        provider: { S: "notion" },
        // Legacy direct-KMS blob (random bytes, no version prefix).
        ciphertext: { B: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]) },
      },
    });
    const storage = makeStorage();
    await expect(storage.get("u", "notion")).rejects.toThrow(/unsupported envelope version/);
  });

  it("rejects when KMS Decrypt returns no plaintext", async () => {
    const plainKey = randomBytes(32);
    const wrappedKey = Buffer.from("wrapped");
    kmsMock.on(GenerateDataKeyCommand).resolves({
      Plaintext: plainKey,
      CiphertextBlob: wrappedKey,
    });
    let storedFrame: Buffer | null = null;
    ddbMock.on(PutItemCommand).callsFake((input) => {
      storedFrame = input.Item.ciphertext.B as Buffer;
      return {};
    });
    const storage = makeStorage();
    await storage.put("u", "notion", { accessToken: "A" });

    ddbMock.on(GetItemCommand).resolves({
      Item: {
        userId: { S: "u" },
        provider: { S: "notion" },
        ciphertext: { B: storedFrame! },
      },
    });
    kmsMock.on(DecryptCommand).resolves({});
    await expect(storage.get("u", "notion")).rejects.toThrow(/no plaintext/);
  });
});
