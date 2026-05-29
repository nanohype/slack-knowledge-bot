import { describe, it, expect, vi } from "vitest";
import type { OAuthRouter } from "almanac-oauth";
import type { IdentityResolver } from "../identity/types.js";
import { createDisconnectCommand, type DisconnectArgs } from "./disconnect-command.js";

function buildArgs(overrides: Partial<{ text: string; user_id: string; email: string | null }>): {
  args: DisconnectArgs;
  ack: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  usersInfo: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn(async () => {});
  const respond = vi.fn(async () => {});
  const usersInfo = vi.fn(async () => ({
    user:
      overrides.email === null
        ? { profile: { email: undefined } }
        : { profile: { email: overrides.email ?? "u1@corp.example" } },
  }));
  const args = {
    command: {
      text: overrides.text ?? "disconnect notion",
      user_id: overrides.user_id ?? "U1",
    },
    ack,
    respond,
    client: { users: { info: usersInfo } },
  } as unknown as DisconnectArgs;
  return { args, ack, respond, usersInfo };
}

function fakeDirectory(
  identity: { externalUserId: string; email: string } | null,
): IdentityResolver {
  return {
    resolveSlackToExternal: vi.fn(async () => identity),
  };
}

function fakeOAuth() {
  const revokeTokens = vi.fn(async () => {});
  const revokeAllForUser = vi.fn(async () => {});
  const oauth = {
    revokeTokens,
    revokeAllForUser,
    // Unused in these tests but required by the interface; cast to unknown
    // is kept to one spot to keep the fake ergonomic.
    getValidToken: vi.fn(),
    handlers: {} as never,
  } as unknown as OAuthRouter;
  return { oauth, revokeTokens, revokeAllForUser };
}

const SOURCE_TO_PROVIDER = {
  notion: "notion",
  confluence: "atlassian",
  drive: "google",
} as const;

describe("createDisconnectCommand", () => {
  it("acks and revokes a single source via the OAuth port", async () => {
    const { args, ack, respond } = buildArgs({ text: "disconnect notion" });
    const { oauth, revokeTokens } = fakeOAuth();
    const cmd = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd.handle(args);
    expect(ack).toHaveBeenCalled();
    expect(revokeTokens).toHaveBeenCalledWith("user-1", "notion");
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("notion") }),
    );
  });

  it("revokes all sources when the user says 'all'", async () => {
    const { args } = buildArgs({ text: "disconnect all" });
    const { oauth, revokeAllForUser, revokeTokens } = fakeOAuth();
    const cmd = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd.handle(args);
    expect(revokeAllForUser).toHaveBeenCalledWith("user-1");
    expect(revokeTokens).not.toHaveBeenCalled();
  });

  it("maps confluence → atlassian and drive → google via sourceToProvider", async () => {
    const { args: a1 } = buildArgs({ text: "disconnect confluence" });
    const { oauth: oauth1, revokeTokens: revoke1 } = fakeOAuth();
    const cmd1 = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth: oauth1,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd1.handle(a1);
    expect(revoke1).toHaveBeenCalledWith("user-1", "atlassian");

    const { args: a2 } = buildArgs({ text: "disconnect drive" });
    const { oauth: oauth2, revokeTokens: revoke2 } = fakeOAuth();
    const cmd2 = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth: oauth2,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd2.handle(a2);
    expect(revoke2).toHaveBeenCalledWith("user-1", "google");
  });

  it("rejects an unknown subcommand and doesn't revoke anything", async () => {
    const { args, respond } = buildArgs({ text: "wat" });
    const { oauth, revokeTokens, revokeAllForUser } = fakeOAuth();
    const cmd = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd.handle(args);
    expect(revokeTokens).not.toHaveBeenCalled();
    expect(revokeAllForUser).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Usage") }),
    );
  });

  it("rejects an unknown source after the valid 'disconnect' subcommand", async () => {
    const { args, respond } = buildArgs({ text: "disconnect github" });
    const { oauth, revokeTokens } = fakeOAuth();
    const cmd = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd.handle(args);
    expect(revokeTokens).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Unknown source") }),
    );
  });

  it("errors out when the user has no Slack email on their profile", async () => {
    const { args, respond } = buildArgs({ text: "disconnect notion", email: null });
    const { oauth, revokeTokens } = fakeOAuth();
    const cmd = createDisconnectCommand({
      identityResolver: fakeDirectory({ externalUserId: "user-1", email: "u1@corp.example" }),
      oauth,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd.handle(args);
    expect(revokeTokens).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("profile email") }),
    );
  });

  it("errors out when the directory can't resolve the user's Slack ID", async () => {
    const { args, respond } = buildArgs({ text: "disconnect notion" });
    const { oauth, revokeTokens } = fakeOAuth();
    const cmd = createDisconnectCommand({
      identityResolver: fakeDirectory(null),
      oauth,
      sourceToProvider: SOURCE_TO_PROVIDER,
    });
    await cmd.handle(args);
    expect(revokeTokens).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("verify your identity") }),
    );
  });
});
