/**
 * The trigger-precision lab (Doc 6 RW.8, Doc 2 R2.8, plan step D2).
 *
 * ## Two proxies for one question, and they are not the same proxy
 *
 * "Does this skill fire when it should, and stay out of the way when it should not" cannot be
 * measured directly without running a real agent against a real skill library. Two things
 * approximate it, and the lab keeps them apart because they fail differently:
 *
 * - **Precision and recall** come from D1's trigger probes: a model is shown the description
 *   and one request and says whether an agent should reach for the skill. That is a judgement
 *   about the *description as written*, which is the thing an author can fix.
 * - **Collision** comes from the A6 vectors: how close the request sits to this skill against
 *   how close it sits to its neighbours in the corpus. That is a retrieval signal, and it is
 *   the half that can say *which other skill would win* — something no amount of judging this
 *   skill alone can reach.
 *
 * Averaging them into one "trigger score" would produce a number nobody could act on, which is
 * the `quality_score` mistake in a new costume. They are reported side by side.
 *
 * ## Free and paid split on cost, not on value
 *
 * Precision and recall read run rows that already exist and cost nothing, so they are free.
 * Collision embeds every probe, so it is the Pro half. The plan's "quick check free, full lab
 * Pro" falls out of what each one actually spends rather than being a line drawn to sell
 * something.
 */

export type ConfusionCounts = {
  /** Should fire, and the probe says it fires. */
  truePositive: number;
  /** Should fire, and the probe says it does not. A missed trigger. */
  falseNegative: number;
  /** Should not fire, and the probe agrees. */
  trueNegative: number;
  /** Should not fire, and the probe says it fires. Noise in every conversation. */
  falsePositive: number;
};

/**
 * Of the requests this skill should answer, how many would reach it.
 *
 * `null` when nothing was measured. **Not zero** — a skill with no should-trigger probes has
 * unknown recall, and rendering that as 0% would tell an author their skill never fires when
 * the truth is that nobody has asked.
 */
export function recall(counts: ConfusionCounts): number | null {
  const total = counts.truePositive + counts.falseNegative;
  return total === 0 ? null : counts.truePositive / total;
}

/**
 * Of the requests this skill would answer, how many it should.
 *
 * `null` when nothing fired at all, and that case is worth stating: zero fires means precision
 * is undefined, not perfect. Returning 1 would give a skill that never triggers a flawless
 * precision score, which is exactly backwards.
 */
export function precision(counts: ConfusionCounts): number | null {
  const fired = counts.truePositive + counts.falsePositive;
  return fired === 0 ? null : counts.truePositive / fired;
}

/**
 * Probes per direction below which a rate is one probe's opinion to two significant figures.
 *
 * The Loop panel marks a share thin below ten sessions for the same reason. Five is lower
 * because a probe is cheap to write and an author will not write ten before wanting to see
 * anything — but the mark is still shown, because 3/4 rendered as "75% recall" is a number
 * somebody will quote.
 */
export const MIN_PROBES_PER_DIRECTION = 5;

export function isThin(counts: ConfusionCounts): boolean {
  return (
    counts.truePositive + counts.falseNegative < MIN_PROBES_PER_DIRECTION ||
    counts.trueNegative + counts.falsePositive < MIN_PROBES_PER_DIRECTION
  );
}

export type Collision = {
  /** The request that is contested. */
  prompt: string;
  /** How close the request sits to this skill's own description, 0–1. */
  own: number;
  /** Corpus skills the request sits closer to. Empty when the skill wins outright. */
  nearer: Array<{ slug: string; name: string; similarity: number }>;
};

export type TriggerReport = {
  counts: ConfusionCounts;
  recall: number | null;
  precision: number | null;
  thin: boolean;
  /** Probes whose newest run does not describe the current document, and so were excluded. */
  staleProbes: number;
  /** Probes with no run at all. Excluded, and named rather than counted as failures. */
  unrunProbes: number;
  /**
   * The collision half. `null` when it was not run — not an empty list, because "no collisions
   * found" and "nobody looked" are opposite conclusions from the same rendering.
   */
  collisions: Collision[] | null;
  /** Index coverage behind the collision half, carried the way `SimilarityReport` carries it. */
  coveragePercent: number;
  coverageReliable: boolean;
};

/** `0.63` → `63%`. Null stays null all the way to the screen. */
export function asPercent(value: number | null): string | null {
  return value === null ? null : `${Math.round(value * 100)}%`;
}

/**
 * How many corpus neighbours to weigh a probe against.
 *
 * Small on purpose. An agent picking from a library considers a handful of candidates, not the
 * whole corpus, and a list of fifty near-misses would bury the one skill that actually beats
 * this one on a request the author cares about.
 */
export const COLLISION_NEIGHBOURS = 5;
