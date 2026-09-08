import "server-only";

import { sql } from "drizzle-orm";

import { BLOCK_TYPES, type BlockType } from "@/lib/block-types";
import { db } from "@/server/db";

import { EXTRACTOR_VERSION } from "./structure";
import {
  LIFT_SIGMA,
  liftStandardError,
  MIN_BAND,
  MIN_LIFT,
  MIN_STRONG_PREVALENCE,
  representatives,
  type Representative,
} from "./archetype";

/**
 * Block-level mining, v1 (Doc 6 RW.2) — does the block grain discriminate?
 *
 * ## The question this exists to answer
 *
 * Doc 6's central bet is that section headings have stopped carrying signal and the
 * functional units inside them still do. That is a testable claim and this is the test. At
 * 97% corpus coverage the best *section* lift across the three largest categories is +10,
 * where bundle-shape traits reach +35 — so the archetype's discriminating power has already
 * moved out of the heading list once. If blocks land near zero too, RW.1's taxonomy has to
 * be pruned rather than built on, and Doc 6 §7 says so explicitly.
 *
 * ## It reuses the miner's own bands and threshold, deliberately
 *
 * `representatives()` and the lift threshold are imported from `archetype.ts` rather than
 * reimplemented. This codebase has already produced two numbers that measured a gate with
 * something that was not the gate — `taxonomy --status` reporting 13 archetype-ready
 * categories while the miner refused one of them, and a near-proxy replacement that agreed
 * to within one and would have swapped a visible contradiction for an invisible one. A
 * second band definition here would be the same mistake a third time: block lift and
 * section lift have to be comparable, and they are only comparable if the bands, the
 * de-duplication to one representative per structure, and the significance rule are
 * literally the same code.
 *
 * ## It does not write an archetype
 *
 * Mining v1 measures and reports. Folding blocks into the published skeleton is C3's job,
 * along with a miner version bump — because the moment a block lift reaches `/build`, every
 * draft in the product is scaffolded from it, and that deserves its own change with its own
 * changelog rather than arriving as a side effect of extraction.
 */

export type MeasuredBlockType = {
  type: BlockType;
  /** Share of strong-band structures carrying at least one block of this type. */
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
  standardError: number;
  /** max(MIN_LIFT, LIFT_SIGMA × standardError) — what it had to beat. */
  requiredLift: number;
  /** Mean blocks of this type per structure, per band. Density, not just presence. */
  strongDensity: number;
  weakDensity: number;
  kept: boolean;
  rejectedFor: string | null;
};

export type BlockMineResult = {
  category: string;
  structures: number;
  strongBand: number;
  weakBand: number;
  /** False when a band is too thin for a percentage over it to mean anything. */
  banded: boolean;
  measured: MeasuredBlockType[];
};

const pct = (count: number, total: number) => (total === 0 ? 0 : Math.round((count / total) * 100));

const mean = (values: number[]) =>
  values.length === 0 ? 0 : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

function measure(
  type: BlockType,
  strong: Representative[],
  weak: Representative[],
): MeasuredBlockType {
  const has = (r: Representative) => r.blockTypes.includes(type);
  const strongPrevalence = pct(strong.filter(has).length, strong.length);
  const weakPrevalence = pct(weak.filter(has).length, weak.length);
  const lift = strongPrevalence - weakPrevalence;

  const standardError = liftStandardError(strongPrevalence, strong.length, weakPrevalence, weak.length);
  const requiredLift = Math.max(MIN_LIFT, LIFT_SIGMA * standardError);

  let rejectedFor: string | null = null;
  if (strongPrevalence < MIN_STRONG_PREVALENCE) {
    rejectedFor = `strong prevalence ${strongPrevalence}% below the ${MIN_STRONG_PREVALENCE}% floor`;
  } else if (lift < requiredLift) {
    rejectedFor = `lift ${lift} below the required ${requiredLift.toFixed(1)}`;
  }

  return {
    type,
    strongPrevalence,
    weakPrevalence,
    lift,
    standardError: Math.round(standardError * 100) / 100,
    requiredLift: Math.round(requiredLift * 10) / 10,
    strongDensity: mean(strong.map((r) => r.blockCounts[type] ?? 0)),
    weakDensity: mean(weak.map((r) => r.blockCounts[type] ?? 0)),
    kept: rejectedFor === null,
    rejectedFor,
  };
}

export async function mineBlockLift(category: string): Promise<BlockMineResult | null> {
  const reps = await representatives(category);
  if (reps.length === 0) return null;

  const strong = reps.filter((r) => r.curated);
  const weak = reps.filter((r) => !r.curated);

  /**
   * Every type is measured and reported, kept or not.
   *
   * `stats.measured` exists on the archetype row for exactly this reason: a section that
   * missed the threshold by two points used to leave no trace, and diagnosing the v7
   * collapse meant four throwaway scripts rebuilding numbers the miner had already computed
   * and discarded. A rejection is a measurement.
   */
  const measured = BLOCK_TYPES.map((type) => measure(type, strong, weak)).sort(
    (a, b) => b.lift - a.lift,
  );

  return {
    category,
    structures: reps.length,
    strongBand: strong.length,
    weakBand: weak.length,
    banded: strong.length >= MIN_BAND && weak.length >= MIN_BAND,
    measured,
  };
}

/**
 * Corpus-wide: which block types separate the bands, and in how many categories.
 *
 * The summary that answers Doc 6 §7's pruning question. A type that clears the threshold in
 * no category at all has earned nothing, whatever its raw prevalence — the same rule the
 * section miner applies, where a section present in 90% of both bands is a fact about
 * markdown rather than advice.
 */
export async function blockLiftAcrossCategories(categories: readonly string[]): Promise<{
  /** Every category that had any representatives at all, banded or not. */
  examined: BlockMineResult[];
  /** The subset with both bands above `MIN_BAND` — the only ones lift is computed over. */
  banded: BlockMineResult[];
  /**
   * Fingerprint coverage at the current extractor version.
   *
   * Returned so the caller can tell "the corpus has no block signal" from "the corpus has
   * not been re-extracted yet", which are the same output and opposite conclusions. The
   * first version of this function returned neither and its CLI printed a table of zeros
   * against 1% coverage — a finding-shaped answer to a question that had no data behind it.
   */
  coverage: { fingerprinted: number; eligible: number };
  byType: Array<{
    type: BlockType;
    keptIn: number;
    bestLift: number;
    bestCategory: string | null;
    medianLift: number;
  }>;
}> {
  const examined: BlockMineResult[] = [];
  for (const category of categories) {
    const result = await mineBlockLift(category);
    if (result) examined.push(result);
  }
  const banded = examined.filter((r) => r.banded);

  /**
   * Counted per **version**, not per joined row.
   *
   * The first version of this left-joined `skill_structures` and counted rows, which was
   * right exactly once: while every version had at most one fingerprint. After the 2.0.0
   * re-extract each version has two — 1.1.0 and 2.0.0 — so the denominator doubled and the
   * command reported **50% coverage at a moment when it was complete**, printing a warning
   * telling the reader to distrust a result that was solid.
   *
   * A `filter` on a fan-out join is the trap: the numerator counts what it should and the
   * denominator counts join output, so the ratio is wrong by exactly the fan-out factor and
   * looks plausible the whole way. Both halves are now subqueries over versions.
   */
  const [coverageRow] = await db
    .select({
      fingerprinted: sql<number>`(
        select count(distinct st.skill_version_id)::int
        from skill_structures st
        join skill_versions sv on sv.id = st.skill_version_id
        where st.extractor_version = ${EXTRACTOR_VERSION}
          and sv.status in ('indexed', 'quarantined')
      )`,
      eligible: sql<number>`(
        select count(*)::int from skill_versions
        where status in ('indexed', 'quarantined')
      )`,
    })
    .from(sql`(select 1) as one`);

  const byType = BLOCK_TYPES.map((type) => {
    const rows = banded
      .map((c) => ({ category: c.category, entry: c.measured.find((m) => m.type === type) }))
      .filter((r): r is { category: string; entry: MeasuredBlockType } => Boolean(r.entry));
    const lifts = rows.map((r) => r.entry.lift).sort((a, b) => a - b);
    const best = rows.reduce<{ category: string; entry: MeasuredBlockType } | null>(
      (acc, r) => (acc === null || r.entry.lift > acc.entry.lift ? r : acc),
      null,
    );
    return {
      type,
      keptIn: rows.filter((r) => r.entry.kept).length,
      bestLift: best?.entry.lift ?? 0,
      bestCategory: best?.category ?? null,
      medianLift: lifts.length === 0 ? 0 : lifts[Math.floor(lifts.length / 2)],
    };
  }).sort((a, b) => b.keptIn - a.keptIn || b.bestLift - a.bestLift);

  return { examined, banded, coverage: coverageRow, byType };
}
