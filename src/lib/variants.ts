/**
 * The activation-cost optimiser (Doc 6 RW.9, plan step D4).
 *
 * ## What A3 measured, and what it was for
 *
 * A3 put a token estimate on every skill: *this costs 4.2K tokens every time it fires*. That
 * was half a feature. The other half is RW.9's actual pitch — **here is a 1.9K version with
 * identical eval results** — and the load-bearing words are the last three.
 *
 * A shorter skill is trivial to produce and worthless unproven. Anyone can ask a model to cut a
 * document by half; the question is whether the thing still works, and that is not a judgement
 * call, it is D1's eval cases run against the variant. So a variant is **never offered until it
 * has been run**, and the offer states what happened rather than that it is shorter.
 *
 * ## The estimator is comparative, and that is exactly what is needed here
 *
 * `estimateTokens` is four characters to the token and says `est.` everywhere, because a real
 * tokenizer is a dependency this project has not taken. That makes it dishonest as a claim
 * about somebody's context window and **honest for comparing two documents measured the same
 * way** — which is the only thing this feature does with it. A3's own note says so; D4 is the
 * caller it was written for.
 */

export const VARIANT_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;

export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export function isVariantStatus(value: unknown): value is VariantStatus {
  return typeof value === "string" && (VARIANT_STATUSES as readonly string[]).includes(value);
}

/**
 * How a variant's eval results compare to the document it came from.
 *
 * Four outcomes rather than a boolean, because "shorter and fine" is only one of them and the
 * other three are all things an author needs to be told plainly.
 */
export const VARIANT_OUTCOMES = ["identical", "improved", "regressed", "unverified"] as const;

export type VariantOutcome = (typeof VARIANT_OUTCOMES)[number];

export type CaseComparison = {
  caseId: string;
  prompt: string;
  /** The verdict against the original document. Null when it was never run there. */
  before: string | null;
  after: string | null;
};

export type VariantReport = {
  outcome: VariantOutcome;
  /** Cases compared on both sides. Only these decide the outcome. */
  compared: number;
  /** Cases with a verdict on one side and not the other. Excluded, and named. */
  incomparable: number;
  regressions: CaseComparison[];
  improvements: CaseComparison[];
  sourceTokens: number;
  variantTokens: number;
  /** Positive means the variant is cheaper. Can be negative — a "compression" can grow. */
  savedTokens: number;
  savedPercent: number;
};

/**
 * Whether a variant is worth offering.
 *
 * Three conditions, and dropping any one of them turns this feature into a document shredder:
 *
 * - **Nothing regressed.** A single case that passed before and fails now disqualifies it
 *   outright, whatever the saving. The pitch is *identical eval results*; a variant that broke
 *   something is a different document, not a cheaper one.
 * - **Something was actually compared.** An unverified variant is a shorter string, and offering
 *   one on the strength of its length is the claim this whole step exists to avoid making.
 * - **It is meaningfully cheaper.** A 2% saving is inside the estimator's own error and is not
 *   worth an author reading a diff for.
 */
export function isOfferable(report: VariantReport): boolean {
  return (
    report.regressions.length === 0 &&
    report.compared > 0 &&
    report.savedPercent >= MIN_SAVING_PERCENT
  );
}

/**
 * Below this, the saving is inside the estimator's own noise.
 *
 * Four characters to the token is an approximation, so a difference of a few per cent between
 * two documents says more about their punctuation than about their cost. Ten points is a
 * difference an author can see in the badge.
 */
export const MIN_SAVING_PERCENT = 10;

export function summariseVariant(input: {
  comparisons: CaseComparison[];
  sourceTokens: number;
  variantTokens: number;
}): VariantReport {
  const comparable = input.comparisons.filter((c) => c.before !== null && c.after !== null);
  const incomparable = input.comparisons.length - comparable.length;

  /*
   * `error` on either side makes a case incomparable rather than failed. A provider refusal
   * while running the variant would otherwise look like the compression breaking something —
   * the same line Skill CI and the matrix both hold.
   */
  const decided = comparable.filter((c) => c.before !== "error" && c.after !== "error");
  const regressions = decided.filter((c) => c.before === "pass" && c.after === "fail");
  const improvements = decided.filter((c) => c.before === "fail" && c.after === "pass");

  const savedTokens = input.sourceTokens - input.variantTokens;
  const savedPercent =
    input.sourceTokens > 0 ? Math.round((savedTokens / input.sourceTokens) * 100) : 0;

  return {
    outcome:
      decided.length === 0
        ? "unverified"
        : regressions.length > 0
          ? "regressed"
          : improvements.length > 0
            ? "improved"
            : "identical",
    compared: decided.length,
    incomparable: incomparable + (comparable.length - decided.length),
    regressions,
    improvements,
    sourceTokens: input.sourceTokens,
    variantTokens: input.variantTokens,
    savedTokens,
    savedPercent,
  };
}

export const VARIANT_OUTCOME_LABEL: Record<VariantOutcome, string> = {
  identical: "Same results",
  improved: "Better results",
  regressed: "Broke something",
  unverified: "Not verified",
};
