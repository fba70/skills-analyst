"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { MAX_FLAG_CONTACT, MAX_FLAG_NOTE } from "@/lib/flags";

/**
 * The public write surface (Doc 2 R2.5, R1.8, R7.5).
 *
 * Three things a person with no account may do: report a problem with a skill, suggest a
 * repository, and file a takedown notice. Until now all three were admin-only, which meant
 * the only route from a reader to the quarantine queue was an analyzer bump.
 *
 * ## Server actions, not route handlers
 *
 * A server action *is* a POST endpoint, so this is not a shortcut past the API-route rule —
 * it is the other side of it. Route handlers in this codebase are barred from the database
 * and exist for wire protocols (MCP) and file downloads; anything that returns a value to
 * our own client bundle is an action, and these do. Each one resolves nothing from a session
 * because there isn't one, and calls the same `src/server/**` function an admin path calls.
 *
 * ## Every one of them is rate limited, and the limiter fails closed here
 *
 * The `publicWrite` scope is deliberately tight — five a minute, thirty an hour — and unlike
 * the MCP read scopes it **refuses when the limiter itself is unavailable**. A read limiter
 * that fails closed takes the public registry dark over data that is public and read-only; a
 * write limiter that fails open lets an unbounded flood into a queue a human has to work
 * through, and the settings coming back does not undo it.
 *
 * ## Nothing here enforces anything
 *
 * A flag lands `received`. A submission lands as an ordinary candidate needing review. A
 * notice lands `received` and unenforced. All three are recorded and none is acted on,
 * because acting on arrival means anybody who can fill in a form can un-list a competitor.
 */

export type PublicResult = { ok: boolean; message: string };

/**
 * Something stable about the caller, for rate limiting and dedup.
 *
 * Hashed with a daily-rotating salt before anything is stored, and the address itself never
 * is — see `src/server/analytics/outcomes.ts`. An action has no `Request`, so the headers
 * come from `next/headers`.
 */
async function callerKey(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}

/**
 * Charge one public write against the limiter, or refuse.
 *
 * `consume` wants a `Request`; an action has headers but no request object, so a minimal one
 * is constructed carrying the forwarding headers the limiter reads. Passing the identity
 * explicitly means the limiter never has to guess.
 */
async function allowWrite(): Promise<PublicResult | null> {
  const { consume } = await import("@/server/mcp/rate-limit");
  const key = await callerKey();
  const request = new Request("https://internal/public-write", {
    headers: key ? { "x-forwarded-for": key } : {},
  });
  const decision = await consume(request, "publicWrite", key ? `ip:${key}` : undefined);
  if (decision.allowed) return null;
  return {
    ok: false,
    message: decision.message,
  };
}

/** R2.5 — a reader reports a problem with a skill. */
export async function flagSkillAction(
  slug: string,
  reason: string,
  note: string,
  contact: string,
): Promise<PublicResult> {
  const refusal = await allowWrite();
  if (refusal) return refusal;

  const { submitFlag } = await import("@/server/curation/flags");
  const outcome = await submitFlag({
    slug,
    reason,
    note: note.slice(0, MAX_FLAG_NOTE),
    contact: contact.slice(0, MAX_FLAG_CONTACT),
    callerKey: await callerKey(),
  });

  if (!outcome.ok) return { ok: false, message: outcome.error };

  revalidatePath(`/skills/${slug}`);
  return {
    ok: true,
    /*
     * A duplicate reads as success with different wording. Saying "you already reported
     * this" confirms an earlier submission landed, which is a small oracle and a needless
     * one — the outcome the reporter wants is unchanged either way.
     */
    message: outcome.duplicate
      ? "Thanks — you have already reported this one today, so nothing was added."
      : "Thanks. A curator will look at it. Nothing is hidden or changed until they do.",
  };
}

/** R1.8 — anyone may suggest a repository. It queues for review; it does not promote. */
export async function submitRepositoryAction(input: string): Promise<PublicResult> {
  const refusal = await allowWrite();
  if (refusal) return refusal;

  const { submitRepository } = await import("@/server/crawl/submit");
  /**
   * `autoPromote: false` is the whole difference from the admin path, and `submit.ts` was
   * written expecting it: *"The public half of R1.8 will pass `false` here and reuse
   * everything below unchanged."* It does.
   *
   * The large-repository gate therefore still applies to a public submission. An admin
   * typing a name into Settings is the human look that gate exists to require; a stranger
   * pasting a URL is not.
   */
  const outcome = await submitRepository(input, {
    submittedBy: "public",
    autoPromote: false,
  });

  if (!outcome.ok) return { ok: false, message: outcome.reason };

  /**
   * The answer is composed from what `submitRepository` actually reports, because "we
   * already have it" is a normal and useful reply to a submission rather than an error.
   * Telling somebody their suggestion was queued when it was already synced would send them
   * away thinking they had contributed something.
   */
  if (outcome.alreadyKnown === "source") {
    return { ok: true, message: `Already indexed — ${outcome.owner}/${outcome.repo} is a source.` };
  }
  if (outcome.alreadyKnown === "discovered") {
    return { ok: true, message: "Already on the discovery list, waiting for a curator." };
  }
  return {
    ok: true,
    message:
      `Thanks — ${outcome.owner}/${outcome.repo} is queued for review` +
      (outcome.skillsFound > 0 ? ` (${outcome.skillsFound} skill markers found).` : ".") +
      " A curator decides before anything is fetched.",
  };
}

/** R7.5 — a rights-holder files a notice. Recorded, and deliberately not enforced. */
export async function submitTakedownAction(
  slug: string,
  requester: string,
  contact: string,
  grounds: string,
  claim: string,
): Promise<PublicResult> {
  const refusal = await allowWrite();
  if (refusal) return refusal;

  const { recordPublicTakedown } = await import("@/server/compliance/takedown");
  const outcome = await recordPublicTakedown({
    slug,
    requester,
    requesterEmail: contact,
    grounds,
    claim,
  });

  if (!outcome.ok) return { ok: false, message: outcome.error };
  return {
    ok: true,
    message:
      "Recorded. A curator reviews every notice before anything is withheld — you will be " +
      "contacted at the address you gave if we need more detail.",
  };
}
