/**
 * Signed one-time URL tokens for the OAuth /start endpoint.
 *
 * The Slack bot shows a button that points at
 * ${APP_BASE_URL}/oauth/{provider}/start?t=<signed-token>. The token is
 * an HMAC-SHA256 signature over (userId, provider, exp) so anyone who
 * intercepts the URL cannot swap the userId or re-use the URL after expiry.
 *
 * Short TTL (5 minutes) because users click these seconds after the bot
 * issues them. Reuses STATE_SIGNING_SECRET — same trust anchor as the
 * module's state cookie.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config/index.js";

const URL_TOKEN_TTL_SECONDS = 300;
const SECRET = () => config.STATE_SIGNING_SECRET;

function hmac(payload: string): string {
  return createHmac("sha256", SECRET()).update(payload).digest("base64url");
}

export function signOAuthStartUrl(userId: string, provider: string): string {
  const exp = Math.floor(Date.now() / 1000) + URL_TOKEN_TTL_SECONDS;
  const payload = `${userId}.${provider}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

export function verifyOAuthStartUrl(token: string, expectedProvider: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, provider, expStr, sig] = parts;
  if (provider !== expectedProvider) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const expected = Buffer.from(hmac(`${userId}.${provider}.${expStr}`), "base64url");
  const actual = Buffer.from(sig, "base64url");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  return userId;
}
