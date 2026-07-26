/**
 * Normalising an unknown throw into something loggable.
 *
 * `catch (err: unknown)` is the honest type — a throw site can produce anything,
 * and a middleware or a transport is exactly the kind of code that throws a bare
 * string. Every call site that logged one of these was re-deriving the same
 * `err instanceof Error ? err.message : String(err)`, which is duplication with a
 * second cost: the non-Error arm is unreachable through an AWS SDK client, so at
 * each site it read as an untested branch that no test could honestly reach.
 *
 * Here it is reachable, and tested once.
 */

/** The message to log for an unknown throw. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The unknown throw as an Error, for APIs that require one (span.recordException). */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
