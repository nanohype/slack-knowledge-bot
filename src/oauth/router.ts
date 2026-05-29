/**
 * Almanac OAuth delegation bootstrap.
 *
 * Wires the almanac-oauth package (scaffolded from nanohype's
 * module-oauth-delegation template) with Almanac's config, storage, and
 * caller-identity semantics. The revocation emitter is port-injected
 * so tests can supply a fake AuditLogger and assert on outgoing events.
 */
import {
  DDBKmsTokenStorage,
  createOAuthRouter,
  notionProvider,
  atlassianProvider,
  googleProvider,
  readStatePayloadUnverified,
  type OAuthRouter,
  type ResolveUserId,
  type RevocationEmitter,
  type TokenStorage,
} from "almanac-oauth";
import type { AuditLogger } from "../audit/audit-logger.js";
import { config } from "../config/index.js";
import { trace } from "@opentelemetry/api";
import { logger } from "../logger.js";
import { verifyOAuthStartUrl } from "./url-token.js";

export const SUPPORTED_PROVIDERS = ["notion", "atlassian", "google"] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Map Almanac's internal source names (as used on RetrievalHit.source) to
 * the OAuth provider name. Atlassian covers Confluence; Google covers Drive.
 */
export const SOURCE_TO_PROVIDER: Record<"notion" | "confluence" | "drive", ProviderName> = {
  notion: "notion",
  confluence: "atlassian",
  drive: "google",
};

export interface AlmanacOAuthConfig {
  auditLogger: AuditLogger;
  storage?: TokenStorage;
  stateSigningSecret?: string;
  appBaseUrl?: string;
}

export interface AlmanacOAuth {
  router: OAuthRouter;
  storage: TokenStorage;
}

function extractProvider(url: URL): string | null {
  const match = url.pathname.match(/^\/oauth\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Almanac's caller-identity resolver.
 *
 * - `/start` carries `?t=<signed-url-token>`. We verify the HMAC and
 *   return the embedded userId.
 * - `/callback` has no URL token. We peek the module's state cookie via
 *   `readStatePayloadUnverified` to recover the userId. The module's
 *   own /callback handler re-verifies the cookie's HMAC before trusting
 *   the payload, so this peek can't be used to bypass anything — a
 *   forgery is caught at the verified step.
 */
const resolveUserId: ResolveUserId = async (req) => {
  const url = new URL(req.url);
  const provider = extractProvider(url);
  if (!provider) {
    logger.warn({ path: url.pathname }, "resolveUserId: no provider in URL");
    return null;
  }

  const token = url.searchParams.get("t");
  if (token) {
    const userId = verifyOAuthStartUrl(token, provider);
    if (!userId) logger.warn({ provider }, "resolveUserId: signed /start token did not verify");
    return userId;
  }

  const cookie = req.headers.get("cookie") ?? "";
  const payload = readStatePayloadUnverified(cookie);
  if (!payload) {
    logger.warn(
      { provider, path: url.pathname, cookiePresent: cookie.length > 0, cookieLen: cookie.length },
      "resolveUserId: state cookie missing or unparseable on callback",
    );
    return null;
  }
  return payload.userId;
};

function buildStorage(): TokenStorage {
  return new DDBKmsTokenStorage({
    tableName: config.DYNAMODB_TABLE_TOKENS,
    keyId: config.KMS_KEY_ID,
    region: config.AWS_REGION,
  });
}

/**
 * Build Almanac's OAuth layer. Bootstrap code calls this once and hands
 * the returned `router` + `storage` to the query handler and HTTP bridge.
 */
export function createAlmanacOAuth(deps: AlmanacOAuthConfig): AlmanacOAuth {
  const storage = deps.storage ?? buildStorage();

  const revocationEmitter: RevocationEmitter = {
    emit: async (event) => {
      // Pull trace_id off the active OTel span so revocation audit rows can
      // be joined back to the request that caused them in Tempo/Loki.
      const span = trace.getActiveSpan();
      const ctx = span?.spanContext();
      const traceId =
        ctx && ctx.traceId && ctx.traceId !== "00000000000000000000000000000000"
          ? ctx.traceId
          : undefined;
      try {
        await deps.auditLogger.emitRevocation({ ...event, traceId });
      } catch (err) {
        // Best effort — the logger already handles primary/DLQ failure.
        logger.error({ err, event }, "revocation audit emission threw");
      }
    },
  };

  const router = createOAuthRouter({
    providers: {
      notion: notionProvider,
      atlassian: atlassianProvider,
      google: googleProvider,
    },
    storage,
    stateSigningSecret: deps.stateSigningSecret ?? config.STATE_SIGNING_SECRET,
    resolveUserId,
    revocationEmitter,
    clientCredentials: {
      notion: {
        clientId: config.NOTION_OAUTH_CLIENT_ID,
        clientSecret: config.NOTION_OAUTH_CLIENT_SECRET,
        redirectUri: `${deps.appBaseUrl ?? config.APP_BASE_URL}/oauth/notion/callback`,
      },
      atlassian: {
        clientId: config.CONFLUENCE_OAUTH_CLIENT_ID,
        clientSecret: config.CONFLUENCE_OAUTH_CLIENT_SECRET,
        redirectUri: `${deps.appBaseUrl ?? config.APP_BASE_URL}/oauth/atlassian/callback`,
      },
      google: {
        clientId: config.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
        redirectUri: `${deps.appBaseUrl ?? config.APP_BASE_URL}/oauth/google/callback`,
      },
    },
  });

  return { router, storage };
}
