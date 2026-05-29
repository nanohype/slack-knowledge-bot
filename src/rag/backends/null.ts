/**
 * No-op retrieval backend. Both methods return `[]` so the generator's
 * zero-hit branch kicks in and the bot answers "I didn't find relevant
 * information in the knowledge base."
 *
 * Wired by `src/index.ts` when `RETRIEVAL_BACKEND_URL` is empty. Useful
 * for first deploys (infra smoke without paying for a vector store) and
 * for tests that exercise the rest of the pipeline without caring about
 * retrieval results.
 */
import type { RetrievalBackend } from "./types.js";

export function createNullBackend(): RetrievalBackend {
  return {
    async knnSearch() {
      return [];
    },
    async textSearch() {
      return [];
    },
  };
}
