/**
 * The launch gates, in one place.
 *
 * Doc 3's rollout stages are gated on three numbers, and until now none of them had a home:
 * G3 and G4 were literals in the loop panel — written twice each, once in the sentence and
 * once in the comparison beside it — and **quarantine precision was a number three files
 * talked about and nothing computed**. A gate that only exists in prose is a gate nobody can
 * fail, which is the same failure as a verdict nobody reads.
 *
 * A leaf module with no imports, for the reason `quality.ts` gives at length: the panel that
 * renders the number is a client component and the reader that computes it is `server-only`,
 * so a shared constant cannot live in either.
 *
 * The percentages are whole numbers on a 0–100 scale, because that is what the panels show
 * and what the requirements are written in. Converting once here is cheaper than converting
 * in every caller and getting it wrong in one of them.
 */

/**
 * Doc 3, stage 2: **≥90% of quarantines are upheld on spot-check.**
 *
 * The gate is about *precision*, not volume: a pipeline that quarantines noisily erodes
 * trust faster than one that misses things, because every false positive costs an author
 * their listing and a curator their afternoon.
 */
export const QUARANTINE_PRECISION_TARGET = 90;

/**
 * How many reviewed quarantines a precision figure needs before it is reported at all.
 *
 * Below this the number is withheld rather than shown greyed out. A percentage over four
 * spot-checks is one curator's morning to two significant figures, and a muted number is
 * still a number somebody will quote — the same rule the archetype outcome panel applies
 * below `MIN_DISTINCT_SKILLS`, and for the same reason.
 *
 * It is deliberately *not* a share of the quarantine queue: 1,053 quarantined versions
 * cannot be reviewed by hand, and a gate whose denominator is the whole queue could never
 * be cleared by any amount of work. Precision is measured on what was spot-checked, and the
 * **coverage is reported beside it** so nobody reads a sample as a census.
 */
export const MIN_REVIEWED_FOR_PRECISION = 20;

/** Doc 2, G3: builder-authored drafts that pass validation first time. */
export const FIRST_PASS_TARGET = 80;

/** Doc 2, G4: builder sessions that use at least one corpus-derived suggestion. */
export const SUGGESTION_USE_TARGET = 60;
