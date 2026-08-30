import "server-only";

/**
 * A one-request channel for "the code was never sent".
 *
 * ## Why this exists at all
 *
 * Better Auth hands our `sendVerificationOTP` to `runInBackgroundOrAwait`, which — with no
 * `advanced.backgroundTasks.handler` configured — does this:
 *
 * ```js
 * try { await promise } catch (e) { logger.error("Failed to run background task:", e) }
 * ```
 *
 * So the send **is** awaited, and its outcome exists by the time the response is built.
 * What is missing is a channel: the throw is logged and swallowed, the endpoint returns
 * 200, and the user is shown "Code sent" for an email that does not exist. A delivery
 * failure was visible only in the server log, which is the one place the person waiting
 * for the code cannot look.
 *
 * This module is that channel. The transport wrapper records a failure here; the server
 * action that asked for the code reads it back and can tell the truth.
 *
 * ## Why a keyed map and not AsyncLocalStorage
 *
 * The obvious answer is request-scoped storage, and we do not control the call site —
 * Better Auth owns the route, so there is nowhere to open a scope around it. Keying by
 * email is the next best thing, and the staleness that would normally make that unsafe is
 * removed by `since`: a reader only accepts a failure recorded **after** it started its own
 * call, so an old failure for the same address can never be mistaken for a new one.
 *
 * Entries are deleted on read and expire on their own. Nothing here is a cache and nothing
 * should ever be read twice.
 */

/** Long enough to outlive one send, short enough that nothing lingers. */
const TTL_MS = 60_000;

type Failure = { at: number; message: string };

/**
 * Module-level, and that is a deliberate limitation worth stating.
 *
 * One process holds this, so a deployment running several instances only reports the
 * failure when the read lands on the instance that wrote it. That is correct here because
 * the write and the read happen inside the *same request* — Better Auth awaits the send
 * before the action returns — so they are always the same process. It would be wrong the
 * moment anything tried to read it from a different request, which is why nothing may.
 */
const failures = new Map<string, Failure>();

const key = (email: string) => email.trim().toLowerCase();

function sweep(now: number) {
  for (const [email, failure] of failures) {
    if (now - failure.at > TTL_MS) failures.delete(email);
  }
}

export function recordSendFailure(email: string, message: string): void {
  const now = Date.now();
  sweep(now);
  failures.set(key(email), { at: now, message });
}

/**
 * Takes a failure recorded for this address at or after `since`, and forgets it.
 *
 * `since` is the whole safety property. Without it, a failure from a previous attempt
 * thirty seconds ago would surface on an attempt that actually succeeded — reporting a
 * problem that no longer exists, which erodes trust in the message exactly as much as the
 * false success did.
 */
export function takeSendFailure(email: string, since: number): string | null {
  const id = key(email);
  const failure = failures.get(id);
  if (!failure) return null;
  failures.delete(id);
  return failure.at >= since ? failure.message : null;
}
