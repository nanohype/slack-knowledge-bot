/**
 * Embeddings through the Platform's ModelGateway.
 *
 * The gateway exposes the OpenAI embeddings shape on `/v1/embeddings` and
 * translates it to a Bedrock Titan `InvokeModel` call, so the vectors are the
 * same Titan vectors as before — this app just no longer holds AWS credentials
 * or names a model.
 *
 * One input per request, because the gateway's translator rejects a batch
 * outright ("AWS Bedrock Titan does not support batch embeddings"). Not a
 * regression: Titan's own API is single-input, so the direct path already sent
 * one text at a time.
 *
 * A small JSON body over an injected `fetch` port rather than a client library —
 * the request is three fields and the response is one array, and a dependency
 * for that would be more surface than the call it wraps. The port is the repo's
 * standing rule for every external boundary: tests hand it a typed fake instead
 * of reaching for a global stub.
 */

/** The subset of the OpenAI embeddings response this reads. */
interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
}

export interface GatewayEmbedderDeps {
  /** The HTTP port. Injected so tests need no global stub. */
  fetchImpl: typeof fetch;
  /** Base URL of the Platform's ModelGateway. */
  endpoint: string;
  /** A route name on that gateway, not a model id. */
  route: string;
  /** Milliseconds before the call is aborted. */
  timeoutMs: number;
  /**
   * Expected vector width, forwarded to the route and asserted on the response.
   * The pgvector column is declared at this width.
   */
  dimensions: number;
}

/**
 * Embed one text, returning its vector.
 *
 * Throws on anything that is not a well-formed vector of the expected width:
 * pgvector rejects a wrong-width vector at insert, which surfaces far from the
 * cause, so the mismatch is caught here instead.
 */
export async function embedViaGateway(text: string, deps: GatewayEmbedderDeps): Promise<number[]> {
  // Trailing slash trimmed so the joined path cannot end up doubled.
  const base = deps.endpoint.replace(/\/+$/, "");
  const response = await deps.fetchImpl(`${base}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: deps.route, input: text, dimensions: deps.dimensions }),
    signal: AbortSignal.timeout(deps.timeoutMs),
  });

  if (!response.ok) {
    // Include the body: the gateway reports a translation refusal (an unmatched
    // route, a batch it will not accept) in it, and without the text those are
    // indistinguishable from an upstream model failure.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `model gateway embeddings failed: ${response.status} ${response.statusText}${
        detail ? ` — ${detail.slice(0, 300)}` : ""
      }`,
    );
  }

  const body = (await response.json()) as EmbeddingsResponse;
  const embedding = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("model gateway returned an embeddings response with no vector");
  }
  if (embedding.length !== deps.dimensions) {
    throw new Error(
      `model gateway returned a ${embedding.length}-dimension vector, expected ${deps.dimensions}`,
    );
  }
  return embedding;
}
