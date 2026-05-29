import { AclProbeError, registerVerifier } from "./registry.js";

const CONFLUENCE_TIMEOUT_MS = 3000;

// Confluence doc IDs encode the Atlassian cloudId so the OAuth 3LO
// probe can hit `api.atlassian.com/ex/confluence/{cloudId}/...` —
// Atlassian's per-site gateway path that a 3LO access token is valid
// against. Format: `confluence:<cloudId>:<pageId>`.
//
//   cloudId: UUID of the Atlassian site (the tenant_info cloudId),
//            fetched via https://{site}.atlassian.net/_edge/tenant_info
//            once at ingest time and baked into the chunk row.
//   pageId:  numeric Confluence content id (from the page URL path).
const CONFLUENCE_DOC_ID_RE = /^confluence:([0-9a-f-]{36}):([^:]+)$/i;

registerVerifier({
  source: "confluence",
  async probe(hit, token, fetchImpl) {
    const match = CONFLUENCE_DOC_ID_RE.exec(hit.docId);
    if (!match) throw new AclProbeError(400, "confluence");
    const [, cloudId, pageId] = match;
    const response = await fetchImpl(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/rest/api/content/${pageId}?expand=version`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(CONFLUENCE_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new AclProbeError(response.status, "confluence");
  },
});
