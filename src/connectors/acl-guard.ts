/**
 * ACL Guard: per-user access verification at the retrieval boundary.
 * Called AFTER vector search returns candidates.
 *
 * SECURITY: This is the critical anti-leak boundary. A user must never
 * see content from a doc they cannot access in the source system, even
 * if it scored highly in the index.
 *
 * Fail-secure: missing token, 403/404 from the source, timeout, or
 * network error → `wasRedacted=true`. The document is dropped from the
 * answer and an audit event records the redaction.
 *
 * Each source (Notion / Confluence / Drive) is wrapped in its own circuit
 * breaker so a single provider going sideways doesn't tar-pit the whole
 * query. When a breaker trips we emit `circuit_open_total{source=...}`
 * once per trip (counter is wired via `deps.onCounter`) and continue to
 * fail-secure on every subsequent hit until the breaker half-opens.
 *
 * Tokens are fetched per-user per-source via the `getAccessToken`
 * callback. The callback's contract is "return a valid access token or
 * null"; almanac-oauth's getValidToken() satisfies it by handling
 * refresh-before-expiry transparently.
 *
 * The HTTP client is injected so tests pass `vi.fn<typeof fetch>()`
 * and production passes global `fetch`. No `vi.mock("axios")` or
 * `vi.mock` of the source SDKs anywhere.
 */
import { SUPPORTED_SOURCES, type RetrievalHit, type Source } from "./types.js";
import { AclProbeError, getVerifier } from "./registry.js";
import { logger } from "../logger.js";
import {
  CircuitOpenError,
  createCircuitBreaker,
  type CircuitBreaker,
} from "../util/circuit-breaker.js";

// Side-effect imports: each module calls registerVerifier() at load time.
import "./notion.js";
import "./confluence.js";
import "./drive.js";

export type GetAccessToken = (source: Source) => Promise<string | null>;

export interface AclGuardConfig {
  fetchImpl: typeof fetch;
  onCounter?: (metric: string, value?: number, dims?: Record<string, string>) => void;
  /** Test hook — override the wall clock used by the per-source breakers. */
  now?: () => number;
}

export interface AclGuard {
  verify(hits: RetrievalHit[], getAccessToken: GetAccessToken): Promise<RetrievalHit[]>;
}

const FAILURE_THRESHOLD = 5;
const WINDOW_MS = 60_000;
const HALF_OPEN_AFTER_MS = 30_000;

export function createAclGuard(deps: AclGuardConfig): AclGuard {
  const onCounter = deps.onCounter ?? (() => {});
  const breakers = new Map<Source, CircuitBreaker>();
  for (const source of SUPPORTED_SOURCES) {
    breakers.set(
      source,
      createCircuitBreaker({
        name: source,
        failureThreshold: FAILURE_THRESHOLD,
        windowMs: WINDOW_MS,
        halfOpenAfterMs: HALF_OPEN_AFTER_MS,
        now: deps.now,
        onOpen: (n) => onCounter("circuit_open_total", 1, { source: n }),
      }),
    );
  }

  return {
    async verify(hits, getAccessToken) {
      return Promise.all(
        hits.map((hit) => verifyOne(hit, getAccessToken, deps.fetchImpl, breakers)),
      );
    },
  };
}

async function verifyOne(
  hit: RetrievalHit,
  getAccessToken: GetAccessToken,
  fetchImpl: typeof fetch,
  breakers: Map<Source, CircuitBreaker>,
): Promise<RetrievalHit> {
  const verifier = getVerifier(hit.source);
  if (!verifier) {
    logger.warn(
      { source: hit.source, docId: hit.docId },
      "no verifier registered for source, redacting",
    );
    return { ...hit, accessVerified: false, wasRedacted: true };
  }
  const token = await getAccessToken(hit.source);
  if (!token) return { ...hit, accessVerified: false, wasRedacted: true };

  // Breakers are seeded for every SUPPORTED_SOURCES entry at guard
  // construction, so this Map.get() is effectively infallible; the
  // non-null assertion keeps the type tight without a dead else-branch.
  const breaker = breakers.get(hit.source)!;
  try {
    await breaker.exec(() => verifier.probe(hit, token, fetchImpl));
    return { ...hit, accessVerified: true, wasRedacted: false };
  } catch (err: unknown) {
    if (err instanceof CircuitOpenError) {
      logger.warn(
        { source: hit.source, docId: hit.docId },
        "ACL probe short-circuited (breaker open), fail-secure",
      );
      return { ...hit, accessVerified: false, wasRedacted: true };
    }
    if (err instanceof AclProbeError && (err.status === 403 || err.status === 404)) {
      return { ...hit, accessVerified: false, wasRedacted: true };
    }
    logger.warn(
      { err, docId: hit.docId, source: hit.source },
      "ACL probe non-auth error, fail-secure",
    );
    return { ...hit, accessVerified: false, wasRedacted: true };
  }
}
