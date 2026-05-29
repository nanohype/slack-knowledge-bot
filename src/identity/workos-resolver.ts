/**
 * IdentityResolver backed by WorkOS Directory Sync.
 *
 * Resolves Slack user → canonical workforce-directory user ID by listing
 * users in the configured directory and matching on email. The result is
 * cached in DynamoDB with a 1-hour TTL so the hot path skips the API
 * call on repeat queries.
 *
 * WorkOS's `/directory_users` endpoint does NOT support filtering by
 * email — the documented query params are `directory`, `group`, `limit`,
 * `before`, `after`, `order`. Passing `email=` returns 422. So we list
 * with `limit=100` and paginate via `after` until we find a match or
 * exhaust the directory. For larger directories this is still fast in
 * practice because (a) results cache for 1h per user, (b) lookups are
 * off the user-facing hot path until identity cache warms.
 *
 * WorkOS auth is a single Bearer API key — no client-credentials token
 * exchange, so (unlike Okta) there's no service-account token refresh,
 * no L1/L2 cache for it, and no `/token` roundtrip on cold start.
 *
 * All external I/O is injected:
 *   - `fetchImpl: typeof fetch` for the WorkOS HTTP call
 *   - `ddbClient`               for the Slack→external identity cache
 *
 * Tests pass `vi.fn<typeof fetch>()` and an `aws-sdk-client-mock`ed
 * DynamoDBClient. No vi.mock of SDK packages.
 *
 * WorkOS Directory Users response shape (the subset we use):
 *   {
 *     data: [{
 *       id: "directory_user_01…",
 *       email: "…",                                    // top-level
 *       emails: [{ primary, value, type }] | [],       // sometimes empty
 *       …
 *     }],
 *     list_metadata: { before, after }
 *   }
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { logger } from "../logger.js";
import type { IdentityResolver, ResolvedIdentity } from "./types.js";

export interface WorkOSResolverConfig {
  fetchImpl: typeof fetch;
  ddbClient: DynamoDBClient;
  workosApiKey: string;
  workosDirectoryId: string;
  identityCacheTable: string;
  baseUrl?: string;
  httpTimeoutMs?: number;
  now?: () => number;
}

interface WorkOSDirectoryUser {
  id: string;
  email?: string;
  emails?: Array<{ primary: boolean; value: string; type?: string }>;
}

interface WorkOSDirectoryUsersResponse {
  data: WorkOSDirectoryUser[];
  list_metadata?: { after?: string | null };
}

const WORKOS_PAGE_SIZE = 100;
const MAX_PAGES = 50;

function primaryEmailOf(user: WorkOSDirectoryUser): string | null {
  if (user.email) return user.email;
  const emails = user.emails ?? [];
  return emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? null;
}

export function createWorkOSResolver(deps: WorkOSResolverConfig): IdentityResolver {
  const baseUrl = deps.baseUrl ?? "https://api.workos.com";
  const timeout = deps.httpTimeoutMs ?? 3000;
  const now = deps.now ?? (() => Date.now());

  async function getCached(slackUserId: string): Promise<ResolvedIdentity | null> {
    const nowSec = Math.floor(now() / 1000);
    const response = await deps.ddbClient.send(
      new GetItemCommand({
        TableName: deps.identityCacheTable,
        Key: { slackUserId: { S: slackUserId } },
      }),
    );
    if (!response.Item) return null;
    const ttl = Number(response.Item.ttl?.N ?? 0);
    if (ttl < nowSec) return null;
    return {
      externalUserId: response.Item.externalUserId?.S ?? "",
      email: response.Item.email?.S ?? "",
    };
  }

  async function writeCache(
    slackUserId: string,
    externalUserId: string,
    email: string,
  ): Promise<void> {
    const ttl = Math.floor(now() / 1000) + 3600;
    await deps.ddbClient.send(
      new PutItemCommand({
        TableName: deps.identityCacheTable,
        Item: {
          slackUserId: { S: slackUserId },
          externalUserId: { S: externalUserId },
          email: { S: email },
          cachedAt: { S: new Date(now()).toISOString() },
          ttl: { N: String(ttl) },
        },
      }),
    );
  }

  return {
    async resolveSlackToExternal(slackUserId, slackEmail) {
      const cached = await getCached(slackUserId);
      if (cached) {
        logger.debug({ slackUserId, source: "cache" }, "identity resolved from cache");
        return cached;
      }
      const wanted = slackEmail.toLowerCase();
      try {
        let after: string | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const url = new URL(`${baseUrl.replace(/\/$/, "")}/directory_users`);
          url.searchParams.set("directory", deps.workosDirectoryId);
          url.searchParams.set("limit", String(WORKOS_PAGE_SIZE));
          if (after) url.searchParams.set("after", after);
          const response = await deps.fetchImpl(url, {
            headers: { Authorization: `Bearer ${deps.workosApiKey}` },
            signal: AbortSignal.timeout(timeout),
          });
          if (!response.ok) {
            const body = await response.text().catch(() => "<no body>");
            logger.warn(
              { status: response.status, url: url.toString(), body: body.slice(0, 500) },
              "WorkOS /directory_users non-2xx",
            );
            throw new Error(`WorkOS /directory_users ${response.status}`);
          }
          const body = (await response.json()) as WorkOSDirectoryUsersResponse;
          for (const user of body.data ?? []) {
            const email = primaryEmailOf(user);
            if (email && email.toLowerCase() === wanted) {
              const identity: ResolvedIdentity = {
                externalUserId: user.id,
                email,
              };
              await writeCache(slackUserId, identity.externalUserId, identity.email);
              return identity;
            }
          }
          after = body.list_metadata?.after ?? null;
          if (!after) break;
        }
        return null;
      } catch (err) {
        logger.error({ err, slackUserId }, "WorkOS identity resolution failed");
        return null;
      }
    },
  };
}
