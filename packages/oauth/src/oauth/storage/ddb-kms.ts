// ── DDBKmsTokenStorage ───────────────────────────────────────────────
//
// Production backend. One DDB row per (userId, provider). Each row
// stores the full TokenGrant JSON encrypted with **envelope
// encryption**:
//
//   1. KMS `GenerateDataKey` issues a one-shot 256-bit AES key
//      bound to `EncryptionContext: { purpose, userId, provider }`.
//      KMS returns the plaintext key and the KMS-encrypted key.
//   2. We AES-256-GCM-encrypt the grant JSON client-side with the
//      plaintext key. No size limit.
//   3. We store `[version | wrappedKeyLen | wrappedKey | iv | tag | ct]`
//      in the `ciphertext` DDB attribute. The plaintext key is
//      zero-filled after use.
//
// On read we extract the wrapped key, `KMS.Decrypt` it (with the
// same EncryptionContext so cross-user leaked blobs stay
// undecryptable), then AES-GCM-decrypt.
//
// This replaces a previous `KMS.Encrypt`-directly implementation
// which crashed on Atlassian token responses (>4 KB KMS plaintext
// limit).
//
// The AWS SDK packages are optional peer dependencies. Install them
// alongside this module if you use this backend.

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { TokenGrant, TokenStorage } from "./types.js";

const ENCRYPTION_PURPOSE = "oauth-token";
const TWO_YEARS_SECONDS = 2 * 365 * 24 * 3600;

// Envelope frame constants.
const FRAME_VERSION = 0x01;
const IV_BYTES = 12; // GCM recommended nonce size
const TAG_BYTES = 16; // GCM auth tag

export interface DDBKmsTokenStorageConfig {
  tableName: string;
  keyId: string;
  region?: string;
  /** Override the DynamoDB client (tests). */
  ddbClient?: DynamoDBClient;
  /** Override the KMS client (tests). */
  kmsClient?: KMSClient;
  /** Override the TTL attribute value (seconds from now). Default: 2 years. */
  ttlSeconds?: number;
}

export class DDBKmsTokenStorage implements TokenStorage {
  private readonly ddb: DynamoDBClient;
  private readonly kms: KMSClient;
  private readonly tableName: string;
  private readonly keyId: string;
  private readonly ttlSeconds: number;

  constructor(config: DDBKmsTokenStorageConfig) {
    this.tableName = config.tableName;
    this.keyId = config.keyId;
    this.ttlSeconds = config.ttlSeconds ?? TWO_YEARS_SECONDS;

    const handler = new NodeHttpHandler({ connectionTimeout: 1000, requestTimeout: 5000 });
    this.ddb =
      config.ddbClient ?? new DynamoDBClient({ region: config.region, requestHandler: handler });
    this.kms =
      config.kmsClient ?? new KMSClient({ region: config.region, requestHandler: handler });
  }

  async get(userId: string, provider: string): Promise<TokenGrant | null> {
    const response = await this.ddb.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          userId: { S: userId },
          provider: { S: provider },
        },
      }),
    );
    const ciphertext = response.Item?.ciphertext?.B;
    if (!ciphertext) return null;
    return this.decrypt(Buffer.from(ciphertext), userId, provider);
  }

  async put(userId: string, provider: string, grant: TokenGrant): Promise<void> {
    const ciphertext = await this.encrypt(grant, userId, provider);
    const now = Math.floor(Date.now() / 1000);
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          userId: { S: userId },
          provider: { S: provider },
          ciphertext: { B: ciphertext },
          updatedAt: { S: new Date().toISOString() },
          ttl: { N: String(now + this.ttlSeconds) },
        },
      }),
    );
  }

  async delete(userId: string, provider: string): Promise<void> {
    await this.ddb.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          userId: { S: userId },
          provider: { S: provider },
        },
      }),
    );
  }

  async deleteAllForUser(userId: string): Promise<void> {
    let exclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
    do {
      const response: QueryCommandOutput = await this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": { S: userId } },
          ProjectionExpression: "userId, #p",
          ExpressionAttributeNames: { "#p": "provider" },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of response.Items ?? []) {
        const provider = item.provider?.S;
        if (!provider) continue;
        await this.ddb.send(
          new DeleteItemCommand({
            TableName: this.tableName,
            Key: {
              userId: { S: userId },
              provider: { S: provider },
            },
          }),
        );
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  private async encrypt(grant: TokenGrant, userId: string, provider: string): Promise<Buffer> {
    const encryptionContext = {
      purpose: ENCRYPTION_PURPOSE,
      userId,
      provider,
    };
    const dataKeyRes = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: "AES_256",
        EncryptionContext: encryptionContext,
      }),
    );
    if (!dataKeyRes.Plaintext || !dataKeyRes.CiphertextBlob) {
      throw new Error("KMS GenerateDataKey returned no key material");
    }
    const plainKey = Buffer.from(dataKeyRes.Plaintext);
    const wrappedKey = Buffer.from(dataKeyRes.CiphertextBlob);

    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", plainKey, iv);
      const plaintext = Buffer.from(JSON.stringify(grant), "utf-8");
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      // Frame: [ver(1) | wrappedKeyLen(2 BE) | wrappedKey | iv(12) | tag(16) | ct]
      if (wrappedKey.length > 0xffff) {
        throw new Error("wrapped data key exceeds 16-bit length");
      }
      const header = Buffer.alloc(3);
      header.writeUInt8(FRAME_VERSION, 0);
      header.writeUInt16BE(wrappedKey.length, 1);
      return Buffer.concat([header, wrappedKey, iv, tag, ct]);
    } finally {
      // Zero the plaintext key material so it doesn't linger in the
      // node process heap longer than necessary.
      plainKey.fill(0);
    }
  }

  private async decrypt(blob: Buffer, userId: string, provider: string): Promise<TokenGrant> {
    if (blob.length < 3 || blob.readUInt8(0) !== FRAME_VERSION) {
      throw new Error(`token storage: unsupported envelope version`);
    }
    const wrappedKeyLen = blob.readUInt16BE(1);
    let offset = 3;
    if (blob.length < offset + wrappedKeyLen + IV_BYTES + TAG_BYTES) {
      throw new Error("token storage: truncated envelope");
    }
    const wrappedKey = blob.subarray(offset, offset + wrappedKeyLen);
    offset += wrappedKeyLen;
    const iv = blob.subarray(offset, offset + IV_BYTES);
    offset += IV_BYTES;
    const tag = blob.subarray(offset, offset + TAG_BYTES);
    offset += TAG_BYTES;
    const ct = blob.subarray(offset);

    const unwrap = await this.kms.send(
      new DecryptCommand({
        CiphertextBlob: wrappedKey,
        EncryptionContext: {
          purpose: ENCRYPTION_PURPOSE,
          userId,
          provider,
        },
      }),
    );
    if (!unwrap.Plaintext) {
      throw new Error("KMS Decrypt returned no plaintext");
    }
    const plainKey = Buffer.from(unwrap.Plaintext);
    try {
      const decipher = createDecipheriv("aes-256-gcm", plainKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(plaintext.toString("utf-8")) as TokenGrant;
    } finally {
      plainKey.fill(0);
    }
  }
}
