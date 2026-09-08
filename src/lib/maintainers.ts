/**
 * Maintainer groups and endorsement (Doc 6 RK.6, plan step E5).
 *
 * ## What this adds to the flag queue
 *
 * B2 gave readers a way to report a problem and a curator a queue to work. That is one direction
 * and one person: anybody may say something is wrong, and one admin decides everything. RK.6's
 * remaining half is the positive direction and a distribution of the work — **named people
 * responsible for a category**, who can work that queue for their own categories and can say a
 * skill is good in a way that carries their name.
 *
 * ## An endorsement is only worth what the endorser is
 *
 * Every other trust signal here is mechanical: verdicts come from analyzers, the quality score
 * from severities, the archetype from prevalence, the lifecycle from evidence. None of them can
 * say *a person who knows this subject has read it and thinks it is right*, and that is the one
 * signal a corpus of 49,000 documents most lacks.
 *
 * It is also the easiest to make worthless. An endorsement from anybody is a like button. So:
 *
 * - **only a maintainer of one of the skill's own categories may endorse it.** The endorsement
 *   carries the category, and it is that pairing rather than the click that means anything;
 * - **nobody endorses a skill published from their own workspace**, which is the cheapest
 *   anti-gaming rule there is;
 * - **it is resolved live against current maintainership.** Somebody who has stopped maintaining
 *   `review` no longer vouches for review skills. Same live-resolution decision as archetype
 *   exemplars, A4's supersession join and the knowledge graph;
 * - **it is pinned to the version that was read.** A re-sync can replace the document underneath
 *   an endorsement, and carrying it forward silently would make a maintainer vouch for text they
 *   never saw. Stale endorsements are labelled, not hidden — the same call the flag queue makes.
 *
 * ## "Nobody has endorsed this" and "no maintainer group covers this" are different sentences
 *
 * The corpus has thirteen function categories and twenty-six domains, and a maintainer group is
 * appointed one category at a time. So for most of this corpus, most of the time, an empty
 * endorsement list means *nobody was eligible*, not *the eligible people declined*. Those read
 * the same and mean the opposite, which is the mistake `archetypes --blocks` made with eleven
 * rows of zeros and the mistake `UNIMPLEMENTED_KINDS` exists to stop the loop panel making.
 * `EndorsementView` therefore carries the eligible-maintainer count beside the list.
 */

/**
 * Which axis a maintainer covers.
 *
 * Mirrors the `category_axis` enum and the taxonomy's own two axes. It is spelled again here
 * rather than imported because this is a leaf module that client components load and the
 * vocabulary lives under `src/server/` — the same split as `dialects.ts` and `block-types.ts`.
 * `verify:maintainers` asserts the two lists are the same, so the copy cannot drift.
 */
export const MAINTAINER_AXES = ["function", "domain"] as const;

export type MaintainerAxis = (typeof MAINTAINER_AXES)[number];

export function isMaintainerAxis(value: unknown): value is MaintainerAxis {
  return typeof value === "string" && (MAINTAINER_AXES as readonly string[]).includes(value);
}

export type Maintainer = {
  userId: string;
  name: string;
  axis: MaintainerAxis;
  category: string;
  categoryLabel: string;
  note: string | null;
  since: Date;
  /** Set when the standing has lapsed. A revoked maintainer is kept, never deleted. */
  revokedAt: Date | null;
};

export type Endorsement = {
  userId: string;
  name: string;
  note: string | null;
  at: Date;
  /** The category the endorser maintains that this skill is in. The reason it counts. */
  axis: MaintainerAxis;
  category: string;
  categoryLabel: string;
  /** The endorsed version is no longer the current one. Labelled, never dropped. */
  stale: boolean;
};

export type EndorsementView = {
  endorsements: Endorsement[];
  /**
   * How many people could endorse this skill at all.
   *
   * Zero and an empty list is *no maintainer group covers this skill's categories*. Non-zero and
   * an empty list is *the people who could have, have not*. Two different things, and a bare
   * count of endorsements cannot tell them apart.
   */
  eligible: number;
  /** Which of the skill's categories have a maintainer group. Named, so the gap is legible. */
  coveredCategories: string[];
};

/**
 * Why an endorsement was refused.
 *
 * Named rather than a boolean, because each case needs a different sentence: one is "you are not
 * the right person", one is "not for your own work", and two are about the skill rather than the
 * endorser.
 */
export const ENDORSE_REFUSALS = [
  "not-a-maintainer",
  "own-work",
  "not-servable",
  "no-version",
] as const;

export type EndorseRefusal = (typeof ENDORSE_REFUSALS)[number];

export const ENDORSE_REFUSAL_MESSAGE: Record<EndorseRefusal, string> = {
  "not-a-maintainer":
    "Endorsing is for maintainers of one of this skill's own categories. That pairing is what makes an endorsement worth anything.",
  "own-work": "You cannot endorse a skill published from your own workspace.",
  "not-servable": "Only an indexed skill can be endorsed.",
  "no-version": "This skill has no current version to endorse.",
};

/** The longest note an endorser may leave. A sentence of why, not a review. */
export const MAX_ENDORSEMENT_NOTE = 280;

/** The longest note an admin may leave on an appointment. */
export const MAX_MAINTAINER_NOTE = 500;

/**
 * How the signal reads on a page.
 *
 * A count with its unit, because "3" beside a badge is ambiguous and "3 maintainers endorse this"
 * is the sentence RK.6 actually asks for. Kept here rather than in the component so the settings
 * panel and the skill page cannot phrase the same fact two ways.
 */
export function endorsementLine(count: number): string {
  if (count === 0) return "No endorsements";
  return count === 1 ? "1 maintainer endorses this" : `${count} maintainers endorse this`;
}
