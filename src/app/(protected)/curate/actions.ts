"use server";

import { revalidatePath } from "next/cache";

import { ENDORSE_REFUSAL_MESSAGE, MAX_ENDORSEMENT_NOTE } from "@/lib/maintainers";

/**
 * Endorsement, from wherever a maintainer happens to be standing (RK.6, plan step E5).
 *
 * ## Why these are not in the public action file
 *
 * `src/app/(public)/actions.ts` is the anonymous write surface: rate-limited, session-free, and
 * every one of its three actions records something a curator later decides on. Endorsing is the
 * opposite on every axis — it needs a session, it needs a *specific* session, and it takes effect
 * immediately because the whole value of the signal is that a named person put their name to it.
 *
 * ## The authorisation is `endorse`'s, not this file's
 *
 * The action resolves the session and passes the user id down; every rule about who may endorse
 * what lives in `src/server/curation/maintainers.ts`, which is also what the CLI and the verify
 * script call. A page guard here would protect the view and not the POST, and a second copy of
 * the rules would be a second thing to keep in step with the first.
 */

export type EndorseActionResult = { ok: boolean; message: string };

export async function endorseAction(
  slug: string,
  note: string,
): Promise<EndorseActionResult> {
  try {
    const { requireSession } = await import("@/server/dal/session");
    const { endorse } = await import("@/server/curation/maintainers");

    const session = await requireSession();
    const outcome = await endorse({
      slug,
      userId: session.user.id,
      // Capped here as well as in the form: a server action is a POST, so `maxLength` is a hint.
      note: note.slice(0, MAX_ENDORSEMENT_NOTE),
    });

    if (!outcome.ok) {
      return { ok: false, message: ENDORSE_REFUSAL_MESSAGE[outcome.refusal] };
    }

    revalidatePath(`/skills/${slug}`);
    revalidatePath("/curate");
    return { ok: true, message: outcome.message };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 300) };
  }
}

export async function withdrawEndorsementAction(slug: string): Promise<EndorseActionResult> {
  try {
    const { requireSession } = await import("@/server/dal/session");
    const { withdrawEndorsement } = await import("@/server/curation/maintainers");

    const session = await requireSession();
    const outcome = await withdrawEndorsement({ slug, userId: session.user.id });

    revalidatePath(`/skills/${slug}`);
    revalidatePath("/curate");
    return outcome;
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 300) };
  }
}
