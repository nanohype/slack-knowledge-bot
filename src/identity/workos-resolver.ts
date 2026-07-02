/**
 * IdentityResolver backed by WorkOS Directory Sync.
 *
 * Resolves Slack user → canonical workforce-directory user ID by
 * matching on email, caching the result in DynamoDB with a 1-hour TTL
 * so the hot path skips the API call on repeat queries.
 *
 * The raw directory access — Bearer-key auth, `limit=100` cursor
 * pagination via `after`, client-side email matching (WorkOS's
 * `/directory_users` rejects an `email=` filter with 422), primary-email
 * selection, and the bounded-page runaway guard — lives in the vendored
 * org-wide client (`src/runtime/workos-directory.ts`, source of truth in
 * nanohype library/runtime). This module owns what the library
 * deliberately leaves to the consumer:
 *
 *   - the DynamoDB identity cache (get + TTL check, write-back on hit)
 *   - per-request HTTP deadlines (`AbortSignal.timeout` wrapped around
 *     the injected fetch before it is handed to the client's fetch port)
 *   - the fail-soft contract (any WorkOS failure → log + null, never a
 *     thrown error into the query pipeline)
 *
 * WorkOS auth is a single Bearer API key — no client-credentials token
 * exchange, so (unlike Okta) there's no service-account token refresh,
 * no L1/L2 cache for it, and no `/token` roundtrip on cold start.
 *
 * All external I/O is injected:
 *   - `fetchImpl: typeof fetch` for the WorkOS HTTP calls
 *   - `ddbClient`               for the Slack→external identity cache
 *
 * Tests pass `vi.fn<typeof fetch>()` and an `aws-sdk-client-mock`ed
 * DynamoDBClient. No vi.mock of SDK packages.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createWorkOsDirectoryClient } from '../runtime/workos-directory.js';
import { logger } from '../logger.js';
import type { IdentityResolver, ResolvedIdentity } from './types.js';

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

export function createWorkOSResolver(deps: WorkOSResolverConfig): IdentityResolver {
  const timeout = deps.httpTimeoutMs ?? 3000;
  const now = deps.now ?? (() => Date.now());

  // Every directory call carries an explicit deadline: wrap the injected
  // fetch so the vendored client's fetch port inherits it per request.
  const timedFetch: typeof fetch = (input, init) =>
    deps.fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeout) });

  const directory = createWorkOsDirectoryClient({
    apiKey: deps.workosApiKey,
    directoryId: deps.workosDirectoryId,
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
    fetchImpl: timedFetch,
  });

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
      externalUserId: response.Item.externalUserId?.S ?? '',
      email: response.Item.email?.S ?? '',
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
        logger.debug({ slackUserId, source: 'cache' }, 'identity resolved from cache');
        return cached;
      }
      try {
        const user = await directory.findByEmail(slackEmail);
        if (!user?.email) return null;
        const identity: ResolvedIdentity = {
          externalUserId: user.id,
          email: user.email,
        };
        await writeCache(slackUserId, identity.externalUserId, identity.email);
        return identity;
      } catch (err) {
        logger.error({ err, slackUserId }, 'WorkOS identity resolution failed');
        return null;
      }
    },
  };
}
