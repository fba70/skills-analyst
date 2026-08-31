/**
 * The quality score, in one place.
 *
 * A leaf module with no imports, for the same reason as `capabilities.ts`: three very
 * different callers need the same numbers. The validator computes the score, the registry
 * colours a badge from it, and the public reference page explains it — and an explanation
 * that drifts from the computation is worse than no explanation, because a reader who
 * checks it and finds it wrong stops trusting the number as well as the page.
 *
 * R2.9 asks for structure, documentation completeness and resource hygiene. `SEVERITY_WEIGHTS`
 * covers structure and hygiene by subtracting for what analyzers found; `substance` supplies
 * completeness, which is the half a penalty model cannot express.
 */

/** What each finding costs, in points off 100. */
export const SEVERITY_WEIGHTS = {
  info: 1,
  low: 3,
  medium: 8,
  high: 20,
  critical: 40,
} as const;

export type Severity = keyof typeof SEVERITY_WEIGHTS;

/**
 * Body size at which a skill earns full completeness credit — roughly 330 words.
 *
 * Enough for a purpose, a trigger and a procedure. This exists because the score used to be
 * `100 - penalties`, which measures *the absence of problems* and calls it quality: a
 * document with almost nothing in it has almost nothing to penalise, so an 8-word skill and
 * a 4-word skill ranked at the very top of the registry, both on a perfect 100, while 87%
 * of the corpus sat at 99 or 100 — a near-constant, not a ranking signal.
 */
export const SUBSTANTIAL_BYTES = 2_000;

/**
 * Credit a defect-free stub still keeps.
 *
 * Thin is not broken, and the distinction matters when the number ranks rather than gates.
 */
export const SUBSTANCE_FLOOR = 0.45;

/** How much of the document is there, 0.45–1. */
export function substanceFactor(bodyBytes: number): number {
  return SUBSTANCE_FLOOR + (1 - SUBSTANCE_FLOOR) * Math.min(1, bodyBytes / SUBSTANTIAL_BYTES);
}

export type QualityBand = "strong" | "fair" | "weak";

/** Where the badge changes colour. Shared so the legend cannot disagree with the badge. */
export const QUALITY_BANDS = { strong: 90, fair: 70 } as const;

export function qualityBand(score: number): QualityBand {
  if (score >= QUALITY_BANDS.strong) return "strong";
  if (score >= QUALITY_BANDS.fair) return "fair";
  return "weak";
}
