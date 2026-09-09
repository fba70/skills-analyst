/**
 * Shared blocks (Doc 6 RK.4, plan step E6) — Team.
 *
 * *"Org-level convention blocks — 'our code style', 'our incident-severity definitions' — defined
 * once, referenced by many skills, updated in one place with dependent-skill re-validation."*
 * The enterprise argument is that fifty internal skills become maintainable instead of fifty
 * copies of drift.
 *
 * ## A transclusion is synced, not substituted, and that is the whole design
 *
 * The obvious build resolves a shared block live: the draft holds a pointer, the render reads the
 * current text, and an edit in one place updates fifty documents at once. Every other pointer in
 * this codebase resolves live — archetype exemplars, supersession, endorsements, the block library
 * — so it looks like the house pattern.
 *
 * **It is the wrong answer here, for two reasons that both bite.**
 *
 * First, `skill_drafts.body` is a *render of `draft_blocks`* with exactly one writer. A block
 * whose text lives somewhere else makes the render depend on a second table, so the body and the
 * blocks beside it can disagree with nothing erroring — the invariant C1 exists to hold.
 *
 * Second, and worse: live substitution **rewrites somebody's document without their knowledge.**
 * A colleague edits a convention at 11am and forty drafts change, in the middle of sentences their
 * authors wrote, with nothing in any revision history saying so. This codebase has a name for that
 * shape — a decision recorded and then applied where nobody asked — and three sections about the
 * times it happened.
 *
 * So a transcluded block **carries its own copy and the version it came from**. When the shared
 * block moves, dependents go *out of date* rather than changing: the update is offered, the author
 * takes it, and it lands in the revision history under its own reason like every other change to a
 * draft. Single source of truth for the *convention*; the author still owns their document.
 *
 * ## Published skills are never touched, and that is not a limitation
 *
 * A published skill is bytes at a content hash that a verdict covers. Re-resolving a transclusion
 * into it would change what the verdict describes while the verdict went on claiming to describe
 * it. So RK.4's *"dependent-skill re-validation"* is a **list**: the shared block says which
 * published skills came from drafts that are now behind, and re-publishing stays the author's
 * deliberate act — the same line `reinstateTakedown` holds about not restoring content it cannot
 * honestly restore.
 */

/** How a shared block relates to a draft that uses it. Derived, never stored. */
export const TRANSCLUSION_STATES = ["current", "behind", "retired"] as const;

export type TransclusionState = (typeof TRANSCLUSION_STATES)[number];

export const TRANSCLUSION_META: Record<TransclusionState, { label: string; blurb: string }> = {
  current: {
    label: "In step",
    blurb: "This block matches the shared convention it came from.",
  },
  behind: {
    label: "Update available",
    blurb:
      "The shared convention changed after this was pulled in. Nothing was rewritten for you — take the update when you are ready, and it lands in the revision history.",
  },
  retired: {
    label: "Convention retired",
    blurb:
      "The shared block this came from has been retired. Your copy is untouched and still yours; it simply no longer tracks anything.",
  },
};

export function transclusionState(input: {
  sharedVersion: number | null;
  blockVersion: number | null;
  retired: boolean;
}): TransclusionState {
  if (input.retired) return "retired";
  if (input.sharedVersion === null || input.blockVersion === null) return "current";
  return input.blockVersion < input.sharedVersion ? "behind" : "current";
}

/**
 * A name a person types and recognises, not a uuid.
 *
 * The whole feature is somebody saying *"use our PII guardrail"*, so the handle has to be
 * memorable. Unique per organisation, lower-cased on comparison for the reason the repository
 * identity fold exists: two conventions differing only in case are one convention and a bug.
 */
export const MAX_SHARED_NAME = 60;

/** A convention is a block, and a block that runs to pages is a section wearing a block's name. */
export const MAX_SHARED_TEXT = 2_000;

export const SHARED_BLOCK_REFUSALS = [
  "not-found",
  "duplicate-name",
  "empty",
  "too-long",
  "retired",
  "untyped",
] as const;

export type SharedBlockRefusal = (typeof SHARED_BLOCK_REFUSALS)[number];

export const SHARED_BLOCK_REFUSAL_MESSAGE: Record<SharedBlockRefusal, string> = {
  "not-found": "No shared block by that name in this workspace.",
  "duplicate-name": "A shared block with that name already exists. Edit it instead of adding a second.",
  empty: "A convention needs to say something.",
  "too-long": `A shared block holds at most ${MAX_SHARED_TEXT} characters. Longer than that is a section, not a convention.`,
  retired: "That convention has been retired and cannot be added to new drafts.",
  untyped:
    "Give the convention a block type. An untyped shared block cannot be compared against an archetype, which is most of what makes it worth sharing.",
};

export type SharedBlock = {
  id: string;
  name: string;
  type: string;
  text: string;
  note: string | null;
  version: number;
  retiredAt: Date | null;
  usedByDrafts: number;
};
