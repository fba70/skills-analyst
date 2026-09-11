import "server-only";

import { sql } from "drizzle-orm";

import {
  PARAMETER_ANALYSER_VERSION,
  parameterById,
  resolveParameter,
  vocabularyReady,
  type MeasuredParameter,
} from "@/lib/decision-surface";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { db } from "@/server/db";
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
 * Does the decision surface discriminate? (Doc 7 RD.5, plan step P7.)
 *
 * ## It reuses the miner's own bands and threshold, deliberately
 *
 * `representatives()`, `liftStandardError`, `MIN_LIFT`, `LIFT_SIGMA`, `MIN_STRONG_PREVALENCE` and
 * `MIN_BAND` are imported, never restated. Parameter lift and block lift are only comparable if
 * the bands, the reduction to one representative per structure and the significance rule are
 * literally the same code — and this codebase has twice produced a number that measured a gate
 * with something that was not the gate, the second time by a near-proxy that agreed to within a
 * point and would have swapped a visible contradiction for an invisible one.
 *
 * ## It does not write an archetype
 *
 * Nothing here reaches a stored skeleton, and that is this step's honest state rather than an
 * omission. Publication needs two things that do not exist yet: a **curated vocabulary** (Doc 7
 * RD.5 says the first sample must be read by a person, and `DECISION_PARAMETERS` is empty until
 * it has been), and a **`MINER_VERSION` bump**, because `mineAndStore` skips on an unchanged
 * skeleton *and* a matching miner version — so a new dimension added without the bump reaches
 * exactly zero archetypes, silently, which is the trap 2.1.0's attribution and 3.0.0's blocks
 * each walked into. `verify:decision-surface` asserts the bump is taken at the same time as the
 * vocabulary, so the two cannot come apart.
 */

export type ParameterMineResult = {
  category: string;
  structures: number;
  strongBand: number;
  weakBand: number;
  banded: boolean;
  /** Representatives with a stored examination at the current analyser version. */
  examined: number;
  /** Of those, how many named a parameter the curated vocabulary recognises. */
  recognised: number;
  measured: MeasuredParameter[];
};

/**
 * Which curated parameters each representative branches on.
 *
 * One query for the whole band, keyed on `skillVersionId` — `tools-mine`'s shape, for a dimension
 * whose evidence is not denormalised onto `skill_structures`. Resolution happens **here**, at read
 * time, so widening the vocabulary re-reads rows rather than re-running 23,476 model calls.
 */
async function parametersByVersion(
  reps: readonly Representative[],
): Promise<{ byVersion: Map<string, Set<string>>; examined: Set<string> }> {
  const byVersion = new Map<string, Set<string>>();
  const examined = new Set<string>();
  if (reps.length === 0) return { byVersion, examined };

  const ids = reps.map((r) => r.skillVersionId);
  /*
   * `any(array[...])`, built element by element — never a bound JS array. Drizzle renders one as
   * a **row constructor**, which Postgres refuses with *op ANY/ALL (array) requires array on
   * right side*, at runtime only. Four times in this codebase, each because the template form
   * reads so naturally.
   *
   * And the reason this paragraph is out here rather than inside the query: prose in a `sql`
   * template is still a template. A `${...}` in a comment interpolates and a backtick terminates
   * the literal, which CLAUDE.md already records from the taxonomy queries and which this very
   * comment tripped on its first write.
   */
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute<{ skill_version_id: string; name: string | null }>(sql`
    select s.skill_version_id, p->>'name' as name
      from skill_parameters s
      left join lateral jsonb_array_elements(s.parameters) p on true
     where s.analyser_version = ${PARAMETER_ANALYSER_VERSION}
       and s.skill_version_id = any(array[${idList}])
  `);

  for (const row of rows) {
    /*
     * The left join means a version examined and found to branch on nothing still appears, with a
     * null name. That row is the whole point of keying the table on the examination: it is the
     * difference between *this skill has no parameters* and *this skill has not been read*, and
     * the denominator below is wrong without it.
     */
    examined.add(row.skill_version_id);
    if (!row.name) continue;
    const id = resolveParameter(row.name);
    if (!id) continue;
    const set = byVersion.get(row.skill_version_id) ?? new Set<string>();
    set.add(id);
    byVersion.set(row.skill_version_id, set);
  }

  return { byVersion, examined };
}

/**
 * Prevalence in both bands, and the threshold it was judged against.
 *
 * Byte-identical arithmetic to `blocks-mine.measure` and `tools-mine.measure`, including building
 * the rejection sentence *before* deciding `kept`, so a parameter that missed by two points leaves
 * a trace rather than vanishing — the gap `stats.measured` was added to close.
 *
 * The denominator is **examined representatives**, not all of them. A band half-extracted would
 * otherwise report every parameter at half its real prevalence, which is a confident wrong answer
 * of exactly the kind a coverage number exists to prevent.
 */
function measure(
  id: string,
  strong: readonly Representative[],
  weak: readonly Representative[],
  byVersion: Map<string, Set<string>>,
): MeasuredParameter {
  const has = (rep: Representative) => byVersion.get(rep.skillVersionId)?.has(id) ?? false;
  const strongCount = strong.filter(has).length;
  const weakCount = weak.filter(has).length;
  const strongPrevalence = strong.length === 0 ? 0 : Math.round((strongCount / strong.length) * 100);
  const weakPrevalence = weak.length === 0 ? 0 : Math.round((weakCount / weak.length) * 100);
  const lift = strongPrevalence - weakPrevalence;

  const standardError = liftStandardError(strongPrevalence, strong.length, weakPrevalence, weak.length);
  const requiredLift = Math.max(MIN_LIFT, LIFT_SIGMA * standardError);

  let rejectedFor: string | null = null;
  if (strongPrevalence < MIN_STRONG_PREVALENCE) {
    rejectedFor = `strong prevalence ${strongPrevalence}% below the ${MIN_STRONG_PREVALENCE}% floor`;
  } else if (lift < requiredLift) {
    rejectedFor = `lift ${lift} below the required ${requiredLift.toFixed(1)}`;
  }

  const curated = parameterById(id);
  return {
    parameter: id,
    label: curated?.label ?? id,
    blurb: curated?.blurb ?? "",
    strongPrevalence,
    weakPrevalence,
    lift,
    strongCount,
    weakCount,
    standardError,
    requiredLift,
    kept: rejectedFor === null,
    rejectedFor,
  };
}

/** One category. Null when it has no labelled skills at all. */
export async function mineParameterLift(category: string): Promise<ParameterMineResult | null> {
  const reps = await representatives(category);
  if (reps.length === 0) return null;

  const strong = reps.filter((r) => r.curated);
  const weak = reps.filter((r) => !r.curated);
  const { byVersion, examined } = await parametersByVersion(reps);

  /*
   * Only parameters present in this category are measured. A table padded with every curated
   * parameter at 0% in both bands would bury the finding in zeros — `tools-mine`'s restraint, and
   * the reason `archetypes --blocks` refuses to print eleven rows of nothing.
   */
  const present = new Set<string>();
  for (const set of byVersion.values()) for (const id of set) present.add(id);

  const measured = [...present]
    .map((id) => measure(id, strong, weak, byVersion))
    .sort((a, b) => b.lift - a.lift || b.strongPrevalence - a.strongPrevalence);

  return {
    category,
    structures: reps.length,
    strongBand: strong.length,
    weakBand: weak.length,
    banded: strong.length >= MIN_BAND && weak.length >= MIN_BAND,
    examined: reps.filter((r) => examined.has(r.skillVersionId)).length,
    recognised: byVersion.size,
    measured,
  };
}

export type ParameterLiftReport = {
  examined: ParameterMineResult[];
  banded: ParameterMineResult[];
  /** Whether a curated vocabulary exists at all. False today, and it gates every claim below. */
  vocabularyReady: boolean;
  coverage: { eligible: number; extracted: number };
  byParameter: Array<{
    parameter: string;
    label: string;
    categories: number;
    keptIn: number;
    bestLift: number;
    medianLift: number;
    bestCategory: string;
  }>;
};

export async function parameterLiftAcrossCategories(
  categories: readonly string[],
): Promise<ParameterLiftReport> {
  const examined: ParameterMineResult[] = [];
  for (const category of categories) {
    const result = await mineParameterLift(category);
    if (result) examined.push(result);
  }
  const banded = examined.filter((r) => r.banded);

  /*
   * Coverage, so the CLI can tell "this dimension carries no signal" from "almost nothing has
   * been extracted". Both halves are subqueries over versions rather than a `filter` on a
   * fan-out join — the bug that made `archetypes --blocks` announce 50% coverage at the moment
   * it was complete.
   */
  const { rows: cov } = await db.execute<{ eligible: number; extracted: number }>(sql`
    select
      (select count(*)::int
         from skill_versions v
         join skills s on s.id = v.skill_id and s.current_version_id = v.id
         join skill_structures st
           on st.skill_version_id = v.id and st.extractor_version = ${EXTRACTOR_VERSION}
        where s.status = 'indexed' and s.org_id is null and s.canonical_skill_id is null
          and v.content_stored = true
          and coalesce((st.block_counts->>'decision-rule')::int, 0) > 0) as eligible,
      (select count(*)::int from skill_parameters
        where analyser_version = ${PARAMETER_ANALYSER_VERSION}) as extracted
  `);

  const byId = new Map<string, { label: string; lifts: number[]; kept: number; best: { lift: number; category: string } }>();
  for (const result of banded) {
    for (const row of result.measured) {
      const entry = byId.get(row.parameter) ?? {
        label: row.label,
        lifts: [],
        kept: 0,
        best: { lift: Number.NEGATIVE_INFINITY, category: "" },
      };
      entry.lifts.push(row.lift);
      if (row.kept) entry.kept += 1;
      if (row.lift > entry.best.lift) entry.best = { lift: row.lift, category: result.category };
      byId.set(row.parameter, entry);
    }
  }

  const byParameter = [...byId.entries()]
    .map(([parameter, entry]) => {
      const sorted = [...entry.lifts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return {
        parameter,
        label: entry.label,
        categories: entry.lifts.length,
        keptIn: entry.kept,
        bestLift: entry.best.lift,
        medianLift:
          sorted.length === 0
            ? 0
            : sorted.length % 2 === 1
              ? sorted[mid]
              : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
        bestCategory: entry.best.category,
      };
    })
    .sort((a, b) => b.keptIn - a.keptIn || b.medianLift - a.medianLift);

  return {
    examined,
    banded,
    vocabularyReady: vocabularyReady(),
    coverage: { eligible: cov[0]?.eligible ?? 0, extracted: cov[0]?.extracted ?? 0 },
    byParameter,
  };
}
