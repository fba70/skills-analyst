/**
 * The with/without matrix (Doc 6 RW.7, plan step D3).
 *
 * ## The question nothing else here can answer
 *
 * Skill CI says the skill passes its golden tasks. The trigger lab says an agent would reach for
 * it. Neither asks the only question a buyer actually has: **does it help?** A skill can pass
 * every task it was written against and add nothing a competent model would not have done
 * unaided — and until the same tasks are run *without* it, that is indistinguishable from a
 * skill that carries real knowledge.
 *
 * So each golden task runs four ways: with the skill and without it, across two models. The
 * number that matters is the difference.
 *
 * ## Two models, because "it helps" is usually "it helps this one"
 *
 * A skill that lifts a small model to a large model's baseline is a real and useful thing, and
 * it is a *different* thing from one that lifts both. One model would report those two cases
 * identically. The pair is a capable model and a cheaper one for exactly that reason.
 *
 * ## A negative delta is the most valuable output
 *
 * A skill that makes results worse is the finding this whole milestone exists to surface, and
 * it is the one an author is least likely to look for. Nothing here clamps at zero, hides a
 * negative, or renders it as "no measurable improvement".
 */

export type MatrixCell = {
  model: string;
  withSkill: boolean;
  passed: number;
  total: number;
};

export type ModelDelta = {
  model: string;
  /** Pass rate with the skill, 0–1. Null when that arm has no complete data. */
  withRate: number | null;
  withoutRate: number | null;
  /** `withRate - withoutRate`. Negative means the skill made things worse. */
  delta: number | null;
};

export type MatrixReport = {
  /** Tasks with a verdict in all four cells at the current document. Only these count. */
  completeTasks: number;
  /**
   * Tasks excluded because some cell is missing or stale.
   *
   * Reported rather than folded in, because a partial matrix is the one failure mode that
   * produces a *confident* number: if the "with" arm ran and the "without" arm was refused by
   * the budget, the delta reads as a perfect result rather than as half a measurement.
   */
  incompleteTasks: number;
  perModel: ModelDelta[];
  /** Mean of the per-model deltas over models that have one. Null when none do. */
  overallDelta: number | null;
  thin: boolean;
  cells: MatrixCell[];
  /**
   * Whether an `eval-delta` outcome signal was written (R6.3).
   *
   * Only possible for a published skill — the signal attaches to a `skill_version`, and a draft
   * has none. False on a draft is correct rather than a failure, and the panel says which.
   */
  recorded: boolean;
  costMicros: number;
};

/**
 * Golden tasks below which a delta is one task's opinion.
 *
 * Lower than it should be for statistics and higher than nothing, which is the honest trade: a
 * matrix costs four producer calls and four judge calls per task, so an author will not write
 * twenty before wanting to see anything. Below this the figure is marked, because "+33%" from
 * three tasks is a single task rendered to two significant figures.
 */
export const MIN_MATRIX_TASKS = 5;

/**
 * The most tasks one matrix run covers.
 *
 * A fuse, like the classifier's `MAX_BATCH` and the eval runner's case cap. Eight tasks is
 * sixty-four model calls, which is where the cost of pressing a button stops being something
 * anybody should discover afterwards.
 */
export const MAX_MATRIX_TASKS = 8;

/** Producer plus judge, with and without, across both models. */
export const CALLS_PER_TASK = 8;

export function deltaFor(cells: MatrixCell[], model: string): ModelDelta {
  const withCell = cells.find((c) => c.model === model && c.withSkill);
  const withoutCell = cells.find((c) => c.model === model && !c.withSkill);

  const rate = (cell: MatrixCell | undefined) =>
    cell && cell.total > 0 ? cell.passed / cell.total : null;

  const withRate = rate(withCell);
  const withoutRate = rate(withoutCell);

  return {
    model,
    withRate,
    withoutRate,
    /*
     * Null unless both arms exist. A delta computed against a missing arm is not a smaller
     * claim, it is a different claim — and it is the shape a budget refusal halfway through a
     * run would produce.
     */
    delta: withRate !== null && withoutRate !== null ? withRate - withoutRate : null,
  };
}

export function summariseMatrix(cells: MatrixCell[]): {
  perModel: ModelDelta[];
  overallDelta: number | null;
} {
  const models = [...new Set(cells.map((c) => c.model))];
  const perModel = models.map((model) => deltaFor(cells, model));
  const measured = perModel.filter((row) => row.delta !== null);

  return {
    perModel,
    overallDelta:
      measured.length === 0
        ? null
        : measured.reduce((sum, row) => sum + (row.delta ?? 0), 0) / measured.length,
  };
}

/** `+0.25` → `+25 points`. Points rather than percent: it is a difference of two rates. */
export function formatDelta(delta: number | null): string | null {
  if (delta === null) return null;
  const points = Math.round(delta * 100);
  return `${points > 0 ? "+" : ""}${points} points`;
}
