import { BLOCK_TYPES, blockTypeLabel, type BlockType } from "./block-types";
import type { BlockRule } from "./parameters";

/**
 * A draft as a list of typed blocks (Doc 6 RW.3, plan step C1).
 *
 * ## Why a draft stops being a body string
 *
 * Everything queued behind this step operates on the *parts* of a document: Interview mode
 * emits candidate blocks a turn at a time, Distill extracts correction patterns as blocks,
 * shared blocks transclude one, improve-an-existing-skill diffs them, and agent-side
 * creation writes them. Each of those is coherent over a list of typed spans and incoherent
 * over one long string — a "revision" to a body string is a text diff nobody can read as a
 * decision, and "accept this suggestion" over a body string is a search-and-replace.
 *
 * The corpus already thinks this way: `skill_blocks` holds 1.6 million typed spans and the
 * archetype for a category is a *block grammar* rather than a heading list. A draft that
 * cannot be compared to that grammar at the same grain is a draft the platform can only
 * advise about vaguely.
 *
 * ## The body is derived; the blocks are the source
 *
 * `skill_drafts.body` stays, and it stays a plain string, because **publish-back (R6.1) and
 * export (R4.4) must not learn about blocks.** They take a body, hand it to the real
 * validator and the real archive builder, and that is precisely what makes those two
 * requirements true — a block-aware export would be a second definition of "servable".
 *
 * So the body becomes a **render**: it is written only by `renderDraftBody`, from the
 * blocks, in the same transaction that writes them. If both were writable they would drift,
 * and the drift is invisible until somebody publishes a document that is not the one they
 * edited. `verify:draft-blocks` asserts the single-writer property against the source tree
 * rather than trusting it.
 *
 * ## This module is a leaf, for the fifth time
 *
 * The compose panel is a client component and `src/server/**` is `server-only`, so the
 * vocabulary and the renderer live here where both can reach them. Same split as
 * `dialects.ts`, `quality.ts`, `capabilities.ts`, `section-roles.ts` and `block-types.ts` —
 * a convention now rather than a discovery. The block *types* are not redefined here: they
 * are imported from `block-types.ts`, which is their one canonical home.
 */

/**
 * What a block is structurally, before anything is said about what it does.
 *
 * Two forms, and the second one is the reason this exists rather than reusing `BlockType`
 * directly. The corpus extractor deliberately treats a heading as a **boundary, not a
 * block** — it is already the fingerprint's own unit, and emitting it twice would
 * double-count every section. That is right for measuring a corpus and fatal for storing a
 * draft: a document reassembled from typed spans alone comes back with every heading gone.
 *
 * So a draft block list tiles the whole document. Headings are blocks here and nowhere else.
 */
export const DRAFT_BLOCK_FORMS = ["heading", "content"] as const;

export type DraftBlockForm = (typeof DRAFT_BLOCK_FORMS)[number];

export function isDraftBlockForm(value: unknown): value is DraftBlockForm {
  return typeof value === "string" && (DRAFT_BLOCK_FORMS as readonly string[]).includes(value);
}

export type DraftBlock = {
  id: string;
  /** Set when this block came from an organisation convention (RK.4). */
  sharedBlockId?: string | null;
  sharedBlockVersion?: number | null;
  /** Position in the document, 0-based and contiguous. */
  order: number;
  form: DraftBlockForm;
  /** 1–6 for a heading, `null` for content. */
  depth: number | null;
  /**
   * One of `BLOCK_TYPES`, or `null`.
   *
   * Null is a first-class answer and stays valid content, exactly as it does in the corpus:
   * Doc 6 §7 names over-structuring as this programme's risk, and a workbench that refused
   * to hold a paragraph until the author picked a label for it would be that risk arriving.
   * Always null for a heading, which has a depth instead.
   */
  type: BlockType | null;
  /** The author's own markdown. For a heading, the label alone without its `#` marks. */
  text: string;
  /**
   * The structure behind a decision rule (Doc 7 RD.2). A `BlockRule` from `parameters.ts`, or
   * null. Carried by every caller that rewrites the list, or a save from the editor would strip
   * the structure off a rule the author never touched.
   */
  rule?: BlockRule | null;
};

/** What a caller supplies. `id` is optional so a new block does not have to invent one. */
export type DraftBlockInput = {
  id?: string;
  form: DraftBlockForm;
  depth?: number | null;
  type?: BlockType | null;
  text: string;
  /** See `DraftBlock.rule`. Ignored on a heading. */
  rule?: BlockRule | null;
  /**
   * The shared convention this block was pulled from (RK.4, plan step E6).
   *
   * Carried through the writer rather than set by a second one, so a transclusion is an ordinary
   * block with a provenance rather than a special case every caller has to know about. The text
   * is still the block's own — see `src/lib/shared-blocks.ts` on why it is synced, not
   * substituted.
   */
  sharedBlockId?: string | null;
  sharedBlockVersion?: number | null;
};

export const MIN_HEADING_DEPTH = 1;
export const MAX_HEADING_DEPTH = 6;

export function clampDepth(depth: number | null | undefined): number {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return 2;
  return Math.min(MAX_HEADING_DEPTH, Math.max(MIN_HEADING_DEPTH, Math.round(depth)));
}

/**
 * One block as markdown.
 *
 * A heading is rebuilt from its depth and label, so changing either is a structured edit
 * rather than a string manipulation the author has to get right. Content is **verbatim**:
 * leading whitespace is load-bearing in markdown (an indented continuation line belongs to
 * the list item above it), so only trailing whitespace is removed, and only so the join
 * below produces exactly one blank line between blocks.
 */
export type RenderableBlock = {
  form: DraftBlockForm;
  depth?: number | null;
  text: string;
};

export function renderDraftBlock(block: RenderableBlock): string {
  if (block.form === "heading") {
    const label = block.text.trim();
    if (!label) return "";
    return `${"#".repeat(clampDepth(block.depth))} ${label}`;
  }
  return block.text.replace(/[ \t\r\n]+$/, "");
}

/**
 * The whole document.
 *
 * Blocks are separated by exactly one blank line, which is markdown's own paragraph
 * separator and the only separation that is unambiguous for every block form — a list
 * followed immediately by a paragraph with no blank line is one list in most parsers.
 *
 * An empty block renders to nothing and is dropped rather than producing a run of blank
 * lines. That matters for C1b: an "add one here" button inserts an empty typed block, and
 * an author who adds three and fills in one should get a document with one new passage,
 * not one with two holes in it.
 */
export function renderDraftBody(blocks: ReadonlyArray<RenderableBlock>): string {
  return blocks
    .map(renderDraftBlock)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Label for any block, for a surface that lists them. Headings say their level. */
export function draftBlockLabel(block: Pick<DraftBlock, "form" | "depth" | "type">): string {
  if (block.form === "heading") return `Heading ${clampDepth(block.depth)}`;
  return block.type ? blockTypeLabel(block.type) : "Free-form";
}

/**
 * The `type` values a content block may take, for a picker.
 *
 * `null` is offered first and named rather than being the absence of a choice, because it
 * is a choice: a passage that is prose and nothing more is a legitimate document, and the
 * corpus says so — 59% of its 1.6 million blocks are untyped.
 */
export const DRAFT_BLOCK_TYPE_OPTIONS: ReadonlyArray<{ value: BlockType | null; label: string }> = [
  { value: null, label: "Free-form" },
  ...BLOCK_TYPES.map((type) => ({ value: type as BlockType | null, label: blockTypeLabel(type) })),
];


// ---------------------------------------------------------------------------------------
// Revisions (Doc 2 R4.7)
// ---------------------------------------------------------------------------------------

/**
 * What changed between two versions of a draft.
 *
 * ## Matched on id, which is why ids survive a replace
 *
 * `setDraftBlocks` deletes a draft's rows and re-inserts the whole list, and it carries the
 * caller's ids through. That looked like a small courtesy for a future feature; it is what
 * makes this function possible. Matching on position instead would report a single insertion
 * near the top as "every block below it changed", and matching on text would lose a block the
 * author retyped without editing.
 *
 * ## Four kinds, because they are four different things an author did
 *
 * A character diff collapses all of them into added-and-removed lines, which is exactly why
 * R4.7 stayed open while a draft was a body string: nobody reads "3,412 characters changed"
 * as *a guardrail was deleted*. `moved` in particular has no expression at all in a text diff
 * — it shows up as a deletion and an unrelated insertion far away.
 */
export type DraftBlockChange =
  | { kind: "added"; to: DraftBlock }
  | { kind: "removed"; from: DraftBlock }
  | { kind: "edited"; from: DraftBlock; to: DraftBlock; retyped: boolean }
  | { kind: "moved"; from: DraftBlock; to: DraftBlock };

export function diffDraftBlocks(
  from: ReadonlyArray<DraftBlock>,
  to: ReadonlyArray<DraftBlock>,
): DraftBlockChange[] {
  const before = new Map(from.map((block) => [block.id, block]));
  const after = new Map(to.map((block) => [block.id, block]));
  const changes: DraftBlockChange[] = [];

  for (const block of to) {
    const previous = before.get(block.id);
    if (!previous) {
      changes.push({ kind: "added", to: block });
      continue;
    }
    const retyped = previous.type !== block.type || previous.form !== block.form;
    if (retyped || previous.text !== block.text || previous.depth !== block.depth) {
      changes.push({ kind: "edited", from: previous, to: block, retyped });
      continue;
    }
    /*
     * Reported only when the content is otherwise identical. A block that was both rewritten
     * and moved is one change to an author, and listing it twice would inflate every count
     * on a history line for no information — the position is on the row either way.
     */
    if (previous.order !== block.order) changes.push({ kind: "moved", from: previous, to: block });
  }

  for (const block of from) {
    if (!after.has(block.id)) changes.push({ kind: "removed", from: block });
  }

  return changes;
}

/** One line for a history list: `2 added · 1 retyped · 3 moved`. Empty when nothing moved. */
export function summariseChanges(changes: ReadonlyArray<DraftBlockChange>): string {
  const counts = {
    added: changes.filter((c) => c.kind === "added").length,
    removed: changes.filter((c) => c.kind === "removed").length,
    retyped: changes.filter((c) => c.kind === "edited" && c.retyped).length,
    rewritten: changes.filter((c) => c.kind === "edited" && !c.retyped).length,
    moved: changes.filter((c) => c.kind === "moved").length,
  };
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (counts.rewritten) parts.push(`${counts.rewritten} rewritten`);
  if (counts.retyped) parts.push(`${counts.retyped} retyped`);
  if (counts.moved) parts.push(`${counts.moved} moved`);
  return parts.join(" · ");
}

/**
 * Why a revision exists. Closed, because it is what a history list groups by.
 *
 * `generated` and `scaffolded` are both the platform acting and are still kept apart: one
 * cost a model call and produced prose, the other cost nothing and produced empty blocks, and
 * an author scanning their own history wants to know which.
 *
 * `interview` is a fifth because a block that arrived through an accepted suggestion has a
 * provenance worth reading in the history: it came from something the author said out loud
 * and then chose to keep, which is a different kind of content from a generated draft.
 *
 * `optimised` is a sixth for the sharpest reason of all: the document got *shorter* and nobody
 * added anything. An author scrolling their history and finding a revision that removed a third
 * of the text needs to know instantly that it was a verified compression rather than a mistake.
 */
export const REVISION_REASONS = [
  "generated",
  "scaffolded",
  "edited",
  "restored",
  "interview",
  /** A block accepted from a Distill run over a transcript (RW.5, plan step C4). */
  "distilled",
  /** An organisation convention pulled in, or a pending update taken (RK.4, plan step E6). */
  "shared",
  "optimised",
  /**
   * Scattered conditionals made into one decision table, a rule row added for an uncovered case,
   * or the Parameters table written or refreshed (Doc 7 RD.1–RD.3, plan step P4). Its own reason
   * because each of those changes the document's *structure* on the author's behalf, and the
   * history is where they would look to ask why three sentences became a table.
   */
  "parameters",
] as const;

export type RevisionReason = (typeof REVISION_REASONS)[number];

export const REVISION_REASON_LABEL: Record<RevisionReason, string> = {
  generated: "Written by the assistant",
  scaffolded: "Scaffolded from the archetype",
  edited: "Edited",
  restored: "Restored",
  interview: "Accepted from an interview",
  distilled: "Distilled from a transcript",
  shared: "Shared convention added or updated",
  optimised: "Compressed by the optimiser",
  parameters: "Parameters and decision rules",
};
