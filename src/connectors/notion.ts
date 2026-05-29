import { AclProbeError, registerVerifier } from "./registry.js";

const NOTION_TIMEOUT_MS = 3000;

registerVerifier({
  source: "notion",
  async probe(hit, token, fetchImpl) {
    const pageId = hit.docId.replace("notion:page:", "");
    const response = await fetchImpl(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
      signal: AbortSignal.timeout(NOTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new AclProbeError(response.status, "notion");
  },
});
