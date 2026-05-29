import { AclProbeError, registerVerifier } from "./registry.js";

const DRIVE_TIMEOUT_MS = 3000;

registerVerifier({
  source: "drive",
  async probe(hit, token, fetchImpl) {
    const fileId = hit.docId.replace("drive:file:", "");
    const response = await fetchImpl(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new AclProbeError(response.status, "drive");
  },
});
