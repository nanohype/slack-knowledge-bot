// ── Handler-shared helpers ───────────────────────────────────────────

import { ConfigError, errorMessage, ProviderError } from "../errors.js";
import type { OAuthProvider, OAuthRouterConfig } from "../types.js";

/** Default timeout for provider token/revoke endpoints. */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * Pull the provider name out of a URL like `/oauth/notion/start`. The
 * `action` segment (`start` / `callback` / `refresh` / `revoke`) is
 * expected at the end — we find the segment immediately before it and
 * call that the provider.
 */
export function extractProvider(url: string, action: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) throw new ConfigError(`unroutable path: ${pathname}`);
  const last = segments[segments.length - 1];
  if (last !== action) throw new ConfigError(`expected action ${action} at end of ${pathname}`);
  return segments[segments.length - 2];
}

/**
 * Pull `returnTo` from the query string, but only accept same-origin paths.
 *
 * Rejects absolute URLs (`http://evil.com`), protocol-relative URLs
 * (`//evil.com`), and anything that doesn't start with a single `/`. This
 * closes the classic OAuth-adjacent open-redirect footgun where an attacker
 * crafts `/oauth/foo/start?returnTo=https://evil.com` and the callback
 * bounces the authenticated user off-site.
 *
 * Consumers who need cross-origin `returnTo` should layer an allowlist on
 * top — it's safer to extend from "deny by default" than the reverse.
 */
export function extractReturnTo(url: string): string {
  const u = new URL(url);
  const raw = u.searchParams.get("returnTo");
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.startsWith("/\\")) return "/";
  return raw;
}

export function providerScopes(
  adapter: OAuthProvider,
  providerName: string,
  config: OAuthRouterConfig,
): string[] {
  const override = config.scopes?.[providerName];
  return override && override.length > 0 ? override : adapter.defaultScopes;
}

/**
 * Post to the provider's token endpoint with a URL-encoded body. Wraps
 * fetch errors so upstream code gets a typed {@link ProviderError}.
 * Callers may pass extra headers (e.g. `Authorization: Basic …` for
 * providers like Notion that reject body-auth).
 */
export async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
  provider: string,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...(extraHeaders ?? {}),
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(provider, "network_error", errorMessage(err));
  }

  if (!response.ok) {
    throw new ProviderError(
      provider,
      "token_endpoint_error",
      `token endpoint returned ${response.status}`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new ProviderError(provider, "invalid_json", errorMessage(err), response.status);
  }
}

/**
 * Build the token-endpoint request pieces for a provider, honouring its
 * declared `tokenAuthStyle`. `"basic"` moves `client_id`+`client_secret`
 * out of the body and into an `Authorization: Basic …` header.
 */
export function buildTokenRequest(
  adapter: OAuthProvider,
  creds: { clientId: string; clientSecret: string },
  bodyFields: Record<string, string>,
): { body: URLSearchParams; headers: Record<string, string> } {
  const style = adapter.tokenAuthStyle ?? "body";
  if (style === "basic") {
    const token = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    return {
      body: new URLSearchParams(bodyFields),
      headers: { authorization: `Basic ${token}` },
    };
  }
  return {
    body: new URLSearchParams({
      ...bodyFields,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    headers: {},
  };
}
