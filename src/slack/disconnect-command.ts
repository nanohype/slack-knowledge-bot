/**
 * `/almanac disconnect [notion|confluence|drive|all]` slash command.
 *
 * Lets a user revoke their own per-source OAuth grants. The revocation
 * flows through almanac-oauth → RevocationEmitter → audit pipeline, so
 * every grant change is logged for compliance.
 *
 * Port-injected: takes the same `identityResolver` + `oauth` ports the
 * query handler uses, so a single factory in `src/index.ts` wires
 * everything consistently. Tests pass fakes implementing the typed
 * interfaces.
 */
import type { AllMiddlewareArgs, App, SlackCommandMiddlewareArgs } from "@slack/bolt";
import type { OAuthRouter } from "almanac-oauth";
import type { IdentityResolver } from "../identity/types.js";
import { SUPPORTED_SOURCES, type Source } from "../connectors/types.js";
import { logger } from "../logger.js";

const USAGE = "Usage: `/almanac disconnect [notion|confluence|drive|all]`";

export type DisconnectArgs = SlackCommandMiddlewareArgs & AllMiddlewareArgs;

export interface DisconnectCommandConfig {
  identityResolver: IdentityResolver;
  oauth: OAuthRouter;
  sourceToProvider: Record<Source, string>;
}

export interface DisconnectCommand {
  registerWith(app: App): void;
  handle(args: DisconnectArgs): Promise<void>;
}

export function createDisconnectCommand(deps: DisconnectCommandConfig): DisconnectCommand {
  async function handle(args: DisconnectArgs): Promise<void> {
    const { command, ack, respond, client } = args;
    await ack();

    const parts = command.text.trim().split(/\s+/).filter(Boolean);
    const [subcommand, target] = parts;

    if (subcommand !== "disconnect" || !target) {
      await respond({ response_type: "ephemeral", text: USAGE });
      return;
    }

    const slackUserId = command.user_id;

    let email: string | undefined;
    try {
      const info = await client.users.info({ user: slackUserId });
      email = info.user?.profile?.email ?? undefined;
    } catch (err) {
      logger.warn({ err, slackUserId }, "users.info failed during /almanac disconnect");
    }
    if (!email) {
      await respond({
        response_type: "ephemeral",
        text: "Could not read your Slack profile email. Make sure your account has a verified email, then retry.",
      });
      return;
    }

    const identity = await deps.identityResolver.resolveSlackToExternal(slackUserId, email);
    if (!identity) {
      await respond({
        response_type: "ephemeral",
        text: "Could not verify your identity. Ensure your Slack account is linked to your workforce directory.",
      });
      return;
    }

    if (target === "all") {
      await deps.oauth.revokeAllForUser(identity.externalUserId);
      await respond({
        response_type: "ephemeral",
        text: "Disconnected all sources. Ask me a question to re-authorize.",
      });
      return;
    }

    if (!SUPPORTED_SOURCES.includes(target as Source)) {
      await respond({
        response_type: "ephemeral",
        text: `Unknown source \`${target}\`. ${USAGE}`,
      });
      return;
    }

    const source = target as Source;
    await deps.oauth.revokeTokens(identity.externalUserId, deps.sourceToProvider[source]);
    await respond({
      response_type: "ephemeral",
      text: `Disconnected *${source}*. Ask me a question to re-authorize.`,
    });
  }

  return {
    handle,
    registerWith(app) {
      app.command("/almanac", handle);
    },
  };
}
