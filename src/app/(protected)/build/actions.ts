"use server";

import { revalidatePath } from "next/cache";

import { isBlockType } from "@/lib/block-types";
import { isDraftBlockForm, type DraftBlock, type DraftBlockInput } from "@/lib/draft-blocks";
import { libraryFragments, type LibraryResult } from "@/server/analytics/block-library";
import { requireSession } from "@/server/dal/session";
import { buildScaffold, type Scaffold } from "@/server/builder/scaffold";
import { createDraft, generateForDraft } from "@/server/builder/drafts";
import type { DraftValidation } from "@/server/builder/validate-body";

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

/**
 * The simplified path: a draft scaffolded as empty typed blocks, with no model call (R4.6).
 *
 * ## Why this is not a lesser version of the wizard
 *
 * R4.6 asks for a route for authors who know what they want to say. Before C1 there was no
 * honest way to offer one — a draft was a body string, so "start it yourself" meant an empty
 * textarea, and the builder's whole argument is that a blank page with a progress bar is
 * what the corpus already knows the answer to.
 *
 * Over blocks it is the same scaffold, unfilled. The archetype's block grammar becomes one
 * empty block of each type, in the order the strong band writes them, with a heading for each
 * section role the skeleton proposes. The author gets the shape and writes the words.
 *
 * ## Empty blocks, never fragments
 *
 * Nothing is pre-filled, and that is the same refusal the block library and C1b's "add one
 * here" both make: most of this corpus is `attribution_required`, and seeding a draft with a
 * stranger's prose would launder an attribution obligation into a document carrying none —
 * on the axis where the download route returns 451. The library is one panel away, to read.
 *
 * ## It costs nothing and it is metered nowhere
 *
 * No model is called, so there is no budget to check and no ledger row to write. That is
 * worth stating because the wizard's own copy promises "one model call": this button
 * promises none, and a spend-capped workspace can still author.
 */
export async function startBlankDraftAction(
  input: SubmitDraftInput,
): Promise<ActionResult<{ draftId: string }>> {
  try {
    const session = await requireSession();
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return { ok: false, message: "No active workspace." };

    if (!input.name.trim()) return { ok: false, message: "Give the skill a name." };
    /*
     * A shorter floor than the wizard's twenty characters, on purpose.
     *
     * There, the purpose is the model's brief and a thin one produces a thin document. Here
     * it is a note to the author's future self, and refusing to create a draft over it would
     * be the form asking for something it does not use.
     */
    if (input.purpose.trim().length < 1) {
      return { ok: false, message: "Say in a line what the skill is for." };
    }

    const scaffold = await buildScaffold(input.category);
    if (!scaffold) return { ok: false, message: "Unknown category." };

    const draftId = await createDraft({
      name: input.name,
      purpose: input.purpose,
      context: input.context.trim() || null,
      category: input.category,
      domain: input.domain || null,
      dialect: input.dialect,
      sectionInputs: input.sectionInputs,
      scaffoldSections: scaffold.sections.map((section) => section.role),
    });

    const { setDraftBlocks } = await import("@/server/builder/blocks");
    await setDraftBlocks(draftId, orgId, blankScaffoldBlocks(scaffold), {
      reason: "scaffolded",
      note: scaffold.archetypeVersion ? `archetype v${scaffold.archetypeVersion}` : null,
      createdBy: session.user.id,
    });

    revalidatePath("/build");
    revalidatePath("/dashboard");
    return { ok: true, data: { draftId } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The archetype, unfilled: a heading per section role, then one empty block per grammar type.
 *
 * The blocks come after the headings rather than being distributed among them, and that is
 * the honest placement. `ScaffoldBlock` says so in its own comment: the miner measures a
 * block type's prevalence across the **whole document**, not per section, so putting
 * `decision-rule` under `steps` would be an arrangement this evidence cannot support. They
 * are ordered by the archetype's `typicalPosition`, which is measured, and the author moves
 * them — which is what C1b's reorder is for.
 */
function blankScaffoldBlocks(scaffold: Scaffold): DraftBlockInput[] {
  const blocks: DraftBlockInput[] = [];
  for (const section of scaffold.sections) {
    blocks.push({ form: "heading", depth: 2, type: null, text: section.label });
  }
  for (const block of scaffold.blocks) {
    if (!isBlockType(block.type)) continue;
    blocks.push({ form: "content", depth: null, type: block.type, text: "" });
  }
  return blocks;
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

/**
 * "Twelve similar skills exist, here is how yours differs" (Doc 2 R3.6).
 *
 * ## Why this is worth an author's attention before they write
 *
 * The dedup data has existed for months and nothing surfaced it to the person about to add
 * to the pile. An author who can see that four near-identical skills already exist will
 * either narrow their scope or decide not to bother, and both are better outcomes than a
 * fifth copy — which is R3.6's point and the half of R5.3 that does not need gap detection.
 *
 * ## It costs one embedding call, and says so upstream
 *
 * ~60 tokens at $0.02/MTok, metered against the platform budget through `embedBatch` like
 * every other model call. Deliberately **not** wired to fire on every keystroke: the wizard
 * asks for it once, on demand, because an autocomplete-shaped feature over a metered call is
 * how a fraction of a cent becomes a bill nobody predicted.
 *
 * The coverage figure travels with the answer. During the backfill "nothing similar exists"
 * and "nothing comparable has been embedded yet" are the same output and opposite
 * conclusions, so the caller is given both and the UI states which it has.
 */
export async function findSimilarAction(text: string): Promise<
  | { ok: true; report: Awaited<ReturnType<typeof import("@/server/analytics/embeddings-run").similarToText>> }
  | { ok: false; message: string }
> {
  try {
    // A session, not an entitlement: R3.6 is free-tier authoring help, and gating it would
    // paywall the advice that stops someone publishing a duplicate.
    await requireSession();

    /**
     * The friendlier message. The *guard* is in `similarToText`, which refuses a short query
     * before charging for it — this only turns that into a sentence an author can act on,
     * rather than an empty list they would read as "nothing similar exists".
     */
    const { MIN_QUERY_CHARS, similarToText } = await import("@/server/analytics/embeddings-run");
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      return { ok: false, message: "Write a little more first — a line or two is enough." };
    }

    const report = await similarToText(trimmed, { limit: 6 });
    return { ok: true, report };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 300) };
  }
}

/**
 * Real fragments of one block type, for the compose panel (Doc 6 RW.3).
 *
 * On demand and one type at a time, like `findSimilarAction` beside it, because each call is
 * a set of object reads against an EU bucket. Loading all of a category's block types with
 * the page would be five bundle fan-outs before the author had asked to see any of them.
 *
 * **Read-only and public data.** The session is still resolved — every action is a POST
 * endpoint and that rule has no exceptions — but nothing here is org-scoped: the library
 * reads the public corpus, and `libraryFragments` pins `org_id is null` so a Team-tier
 * private skill's blocks can never surface as somebody else's example (RC.5).
 */
export async function blockFragmentsAction(
  category: string,
  type: string,
): Promise<ActionResult<LibraryResult>> {
  try {
    await requireSession();
    if (!isBlockType(type)) return { ok: false, message: "Unknown block type." };
    const result = await libraryFragments({
      category,
      type,
      limit: 4,
      /*
       * The wider corpus is allowed here, and only here.
       *
       * A thin category's curated band may hold no fragment of a type it nonetheless
       * recommends, and "no examples" is a worse answer than "examples from the wider
       * corpus". Every fragment carries `curated`, so the panel labels the two rather than
       * presenting them as equivalent.
       */
      includeWiderCorpus: true,
    });
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}


/**
 * Save a draft's blocks (plan step C1b).
 *
 * ## The whole list, every time
 *
 * Reorder, retype, split, merge, delete and insert are all "the list is now this" from the
 * client's point of view, and they are one write here. The alternative — an operation per
 * gesture — would need each one to renumber `block_order` correctly against a unique index,
 * six times, with six chances to get it wrong, for no gain at the tens of rows a draft holds.
 *
 * **Ids travel with the blocks.** A block the author only moved keeps its id, so a decision
 * attached to it later (C2b's accept/reject, D1's eval case) survives every gesture that is
 * not a delete.
 *
 * ## The body is re-rendered and re-validated inside the write
 *
 * `setDraftBlocks` does both in the transaction that stores the rows, so the body, the
 * findings and the quality score on the page always describe the blocks beside them. A
 * validation that lagged one save behind would be worse than none — an author would fix a
 * finding, see it still there, and fix it twice.
 */
export async function saveDraftBlocksAction(
  draftId: string,
  blocks: DraftBlockInput[],
): Promise<ActionResult<{ blocks: DraftBlock[]; body: string; validation: DraftValidation }>> {
  try {
    const session = await requireSession();
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return { ok: false, message: "No active workspace." };

    if (blocks.length > MAX_DRAFT_BLOCKS) {
      return {
        ok: false,
        message: `A draft holds up to ${MAX_DRAFT_BLOCKS} blocks. Split it into two skills.`,
      };
    }

    /*
     * Sanitised here rather than trusted, because a server action is a POST endpoint and
     * this one takes a shape rather than a scalar. `setDraftBlocks` normalises again — it has
     * to, since generation and R5.6's import reach it without passing through an action — so
     * this is the boundary check and that is the invariant, not a duplicate of it.
     */
    const clean: DraftBlockInput[] = blocks.map((block) => ({
      id: typeof block.id === "string" && UUID.test(block.id) ? block.id : undefined,
      form: isDraftBlockForm(block.form) ? block.form : "content",
      depth: typeof block.depth === "number" ? block.depth : null,
      type: isBlockType(block.type) ? block.type : null,
      text: typeof block.text === "string" ? block.text.slice(0, MAX_BLOCK_CHARS) : "",
    }));

    const { setDraftBlocks } = await import("@/server/builder/blocks");
    const result = await setDraftBlocks(draftId, orgId, clean, {
      reason: "edited",
      createdBy: session.user.id,
    });

    revalidatePath(`/build/${draftId}`);
    revalidatePath("/build");
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bounds, both stated rather than discovered.
 *
 * `block_order` is a `smallint`, so the row count has a hard ceiling anyway; 400 is far
 * below it and far above any real document — the largest corpus skill segments into 180-odd
 * blocks. The per-block cap is generous for the same reason: `MAX_BODY_BYTES` is 40,000 for
 * the whole document, so a single 20,000-character block is already a structural-lint
 * finding rather than something this action should be the first to complain about.
 */
const MAX_DRAFT_BLOCKS = 400;
const MAX_BLOCK_CHARS = 20_000;


/**
 * Put a draft back to an earlier revision (R4.7).
 *
 * Appends rather than rewinds — see `restoreDraftRevision`. The action adds only the session
 * and the cache invalidation, which is the shape every action here takes: the reasoning worth
 * having lives in `src/server/**`, where the CLI and a future MCP tool reach it too.
 */
export async function restoreRevisionAction(
  draftId: string,
  revision: number,
): Promise<ActionResult<{ revision: number | null }>> {
  try {
    const session = await requireSession();
    const orgId = session.session.activeOrganizationId;
    if (!orgId) return { ok: false, message: "No active workspace." };

    const { restoreDraftRevision } = await import("@/server/builder/blocks");
    const result = await restoreDraftRevision(draftId, orgId, revision, session.user.id);

    revalidatePath(`/build/${draftId}`);
    revalidatePath("/build");
    return { ok: true, data: { revision: result.revision } };
  } catch (error) {
    return failure(error);
  }
}
