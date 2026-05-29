import { SourceCitation } from "../connectors/types.js";

interface FormattedResponse {
  blocks: SlackBlock[];
  text: string;
}
interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

const EMOJI = {
  WARNING: "\u26a0\ufe0f", // ⚠️
  LOCK: "\ud83d\udd12", // 🔒
  HOURGLASS: "\u23f3", // ⏳
  BULLET: "\u2022", // •
  EM_DASH: "\u2014", // —
} as const;

const SOURCE_NAMES: Record<SourceCitation["source"], string> = {
  notion: "Notion",
  confluence: "Confluence",
  drive: "Google Drive",
};

const FOOTER_TEXT = `Powered by *Almanac* ${EMOJI.EM_DASH} answers are grounded in NanoCorp's knowledge base.`;
const REDACTED_TEXT = `${EMOJI.LOCK} _Note: Some relevant documents were not accessible under your account. You may need to request access._`;

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function divider(): SlackBlock {
  return { type: "divider" };
}

function footer(): SlackBlock {
  return context(FOOTER_TEXT);
}

function citation(c: SourceCitation): SlackBlock {
  const dateNote = c.isStale
    ? ` ${EMOJI.WARNING} _Last updated ${formatDate(c.lastModified)} ${EMOJI.EM_DASH} may be outdated_`
    : ` _Updated ${formatDate(c.lastModified)}_`;
  return context(`${EMOJI.BULLET} <${c.url}|${c.title}>${dateNote}`);
}

export function formatAnswer(
  answerText: string,
  citations: SourceCitation[],
  hasRedactedHits: boolean,
  hasNoHits: boolean,
): FormattedResponse {
  const blocks: SlackBlock[] = [section(answerText)];

  if (citations.length > 0) {
    blocks.push(divider());
    blocks.push(context("*Sources:*"));
    for (const c of citations) blocks.push(citation(c));
  }

  if (hasRedactedHits && !hasNoHits) {
    blocks.push(divider());
    blocks.push(context(REDACTED_TEXT));
  }

  blocks.push(footer());

  return {
    blocks,
    text: hasNoHits
      ? answerText
      : `${answerText.slice(0, 150)}... [${citations.length} source(s) cited]`,
  };
}

export function formatOAuthPrompt(
  sources: Array<SourceCitation["source"]>,
  authLinks: Record<string, string>,
): FormattedResponse {
  const blocks: SlackBlock[] = [
    section("To answer your question, Almanac needs access to the following knowledge sources:"),
  ];
  for (const source of sources) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${EMOJI.BULLET} *${SOURCE_NAMES[source]}*` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: `Connect ${SOURCE_NAMES[source]}` },
        url: authLinks[source],
        action_id: `oauth_connect_${source}`,
      },
    });
  }
  blocks.push(
    context(
      "Almanac only reads documents you have access to. Your credentials are encrypted and stored securely.",
    ),
  );
  return {
    blocks,
    text: "Almanac needs access to your knowledge sources to answer this question.",
  };
}

export interface RateLimitCopyOptions {
  userPerHour: number;
  workspacePerHour: number;
  /** Test hook — override the wall clock used to compute the wait window. */
  now?: () => number;
}

export function formatRateLimitMessage(
  limitType: "user" | "workspace",
  resetAt: number,
  opts: RateLimitCopyOptions,
): FormattedResponse {
  const now = opts.now ?? (() => Date.now());
  const minutesUntilReset = Math.max(1, Math.ceil((resetAt - now()) / 60_000));
  const waitCopy = minutesUntilReset === 1 ? "1 minute" : `${minutesUntilReset} minutes`;
  const message =
    limitType === "user"
      ? `You've reached your query limit (${opts.userPerHour} queries/hour). Try again in about ${waitCopy}.`
      : `The workspace query limit (${opts.workspacePerHour} queries/hour) has been reached. Try again in about ${waitCopy}.`;
  return {
    blocks: [section(`${EMOJI.HOURGLASS} ${message}`)],
    text: message,
  };
}

/**
 * Consistent error surface for user-facing failures (identity not found,
 * Slack profile email missing, etc.). Includes the trace ID so users can
 * cite it to ops without copy-pasting log lines.
 */
export function formatError(message: string, traceId: string): FormattedResponse {
  return {
    blocks: [section(message), context(`Trace ID: \`${traceId}\``)],
    text: `${message} (Trace ID: ${traceId})`,
  };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
