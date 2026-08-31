"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/server/dal/session";
import { buildScaffold, type Scaffold } from "@/server/builder/scaffold";
import { createDraft, generateForDraft } from "@/server/builder/drafts";

/**
 * Builder actions (Doc 2 R4.x).
 *
 * **Every action re-resolves the session.** A server action is a POST endpoint — the
 * layout's `requireSession()` controls who sees the page, not who can call this. The DAL
 * then scopes every draft read and write to the caller's organisation, so an id from
 * another org resolves to nothing rather than to someone else's work.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; message: string };

function failure(error: unknown): { ok: false; message: string } {
  return { ok: false, message: (error as Error).message.slice(0, 300) };
}

/**
 * The archetype-derived form for a category.
 *
 * Fetched on demand rather than with the page: there are thirteen categories and each
 * scaffold is an archetype read plus an exemplar resolution, so loading all of them to
 * render a list of thirteen buttons would be twelve wasted round trips every time.
 */
export async function loadScaffoldAction(category: string): Promise<ActionResult<Scaffold>> {
  try {
    await requireSession();
    const scaffold = await buildScaffold(category);
    if (!scaffold) return { ok: false, message: "Unknown category." };
    return { ok: true, data: scaffold };
  } catch (error) {
    return failure(error);
  }
}

export type SubmitDraftInput = {
  name: string;
  purpose: string;
  context: string;
  category: string;
  /** Empty string means "not domain-specific", which is a real answer and stays null. */
  domain: string;
  dialect: string;
  sectionInputs: Record<string, string>;
  scaffoldSections: string[];
};

/**
 * Saves the author's inputs, then writes the draft.
 *
 * Two steps in one action, and the order matters: the inputs are committed before the
 * model is called, so a generation that fails or refuses leaves the typing intact and the
 * author retries from the draft rather than from the form.
 */
export async function submitDraftAction(
  input: SubmitDraftInput,
): Promise<ActionResult<{ draftId: string; refused: boolean; reason?: string }>> {
  try {
    await requireSession();

    if (!input.name.trim()) return { ok: false, message: "Give the skill a name." };
    if (input.purpose.trim().length < 20) {
      return {
        ok: false,
        message: "Say a little more about what the skill is for — a sentence or two.",
      };
    }

    const draftId = await createDraft({
      name: input.name,
      purpose: input.purpose,
      context: input.context.trim() || null,
      category: input.category,
      domain: input.domain || null,
      dialect: input.dialect,
      sectionInputs: input.sectionInputs,
      scaffoldSections: input.scaffoldSections,
    });

    const result = await generateForDraft(draftId);
    revalidatePath("/build");
    revalidatePath("/dashboard");

    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      data: {
        draftId,
        refused: result.refused,
        reason: result.refused ? result.reason : undefined,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Re-writes an existing draft from the inputs already stored on it. */
export async function regenerateDraftAction(
  draftId: string,
): Promise<ActionResult<{ refused: boolean; reason?: string }>> {
  try {
    await requireSession();
    const result = await generateForDraft(draftId);
    revalidatePath(`/build/${draftId}`);
    revalidatePath("/build");

    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      data: { refused: result.refused, reason: result.refused ? result.reason : undefined },
    };
  } catch (error) {
    return failure(error);
  }
}


/**
 * Publishes a draft into the workspace corpus (R6.1).
 *
 * Thin on purpose: the interesting part is that `publishDraft` writes the same rows a sync
 * writes and hands the version to the same validator, so there is nothing for an action to
 * add beyond the session check and cache invalidation.
 */
export async function publishDraftAction(
  draftId: string,
): Promise<ActionResult<{ slug: string; status: string; qualityScore: number; reasons: string[] }>> {
  try {
    await requireSession();
    const { publishDraft } = await import("@/server/builder/publish");
    const result = await publishDraft(draftId);
    if (!result.ok) return { ok: false, message: result.message };

    revalidatePath(`/build/${draftId}`);
    revalidatePath("/build");
    revalidatePath("/dashboard");
    revalidatePath("/skills");

    return {
      ok: true,
      data: {
        slug: result.slug,
        status: result.status,
        qualityScore: result.qualityScore,
        reasons: result.reasons,
      },
    };
  } catch (error) {
    return failure(error);
  }
}
