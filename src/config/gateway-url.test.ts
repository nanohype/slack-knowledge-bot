import { describe, expect, it } from "vitest";
import { anthropicBaseUrl } from "./gateway-url.js";

const GATEWAY =
  "http://slack-knowledge-bot-gateway.tenants-slack-knowledge-bot.svc.cluster.local:8080";

describe("anthropicBaseUrl", () => {
  it("puts the SDK's /v1/messages under the gateway's anthropic prefix", () => {
    // What the Anthropic SDK ultimately requests, spelled out: it appends
    // /v1/messages to the base URL. The assertion is on that full path rather
    // than on the base alone, because the full path is what has to match a
    // registered gateway endpoint.
    expect(`${anthropicBaseUrl(GATEWAY)}/v1/messages`).toBe(`${GATEWAY}/anthropic/v1/messages`);
  });

  it("does not return the bare gateway root", () => {
    // The regression. Handing the root to the SDK produces /v1/messages, which
    // is registered under no endpoint prefix — the OpenAI-shaped set at the
    // root has no `messages` member. Requests are routed nowhere and every
    // model call fails while the Gateway reports healthy.
    expect(anthropicBaseUrl(GATEWAY)).not.toBe(GATEWAY);
  });

  it("does not double the separator when the endpoint has a trailing slash", () => {
    expect(anthropicBaseUrl(`${GATEWAY}/`)).toBe(`${GATEWAY}/anthropic`);
  });

  it("leaves the OpenAI-shaped endpoints reachable from the untouched root", () => {
    // Embeddings speak the OpenAI shape, which the gateway serves at the root.
    // The prefix belongs to the Anthropic client alone; applying it globally
    // would break the embeddings path instead.
    expect(anthropicBaseUrl(GATEWAY).startsWith(GATEWAY)).toBe(true);
  });
});
