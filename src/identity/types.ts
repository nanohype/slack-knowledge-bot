/**
 * Identity resolution port.
 *
 * Maps a Slack user to the canonical workforce-directory user ID used
 * downstream (audit trail, per-user OAuth token lookup, ACL decisions).
 * The current implementation in `workos-resolver.ts` resolves through
 * WorkOS Directory Sync; a client fork can swap in any other
 * implementation (Okta, Azure Entra, Google Admin, a local directory
 * file) by constructing an object that satisfies this interface and
 * passing it to `src/index.ts` bootstrap.
 *
 * The `externalUserId` field is provider-agnostic — it's whatever the
 * chosen directory calls the canonical user. WorkOS calls it
 * `directory_user.id`; Okta calls it `id` on its Users resource;
 * Entra calls it `objectId`. Downstream code only cares that it's
 * stable within a single deploy.
 */

export interface ResolvedIdentity {
  /**
   * Canonical user ID from the configured identity directory. Stable
   * for the lifetime of the user's row in that directory.
   */
  externalUserId: string;
  /** The directory's view of the user's primary email. */
  email: string;
}

export interface IdentityResolver {
  resolveSlackToExternal(slackUserId: string, slackEmail: string): Promise<ResolvedIdentity | null>;
}
