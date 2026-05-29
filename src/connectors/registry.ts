import type { RetrievalHit } from "./types.js";

export type SourceType = RetrievalHit["source"];

/**
 * A connector verifier probes the source's API to confirm the asking
 * user can read `hit.docId`. The OAuth access token is supplied by the
 * caller (acl-guard → almanac-oauth getValidToken) rather than pulled
 * from an Almanac-local token bag.
 *
 * `fetchImpl` is injected per call so acl-guard controls the HTTP port
 * in one place. Tests hand in a `vi.fn<typeof fetch>()`; production
 * hands in global `fetch`. The probe throws on non-2xx — acl-guard
 * maps 403/404 (and any other failure) to `wasRedacted: true`.
 */
export interface ConnectorVerifier {
  source: SourceType;
  probe(hit: RetrievalHit, accessToken: string, fetchImpl: typeof fetch): Promise<void>;
}

export class AclProbeError extends Error {
  constructor(
    readonly status: number,
    readonly source: SourceType,
  ) {
    super(`${source} probe ${status}`);
  }
}

const verifiers = new Map<SourceType, ConnectorVerifier>();

export function registerVerifier(v: ConnectorVerifier): void {
  verifiers.set(v.source, v);
}

export function getVerifier(source: SourceType): ConnectorVerifier | undefined {
  return verifiers.get(source);
}

/** Test helper — reset between specs so side-effect registrations stay deterministic. */
export function __resetVerifiersForTests(): void {
  verifiers.clear();
}
