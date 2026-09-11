import "server-only";

import { sql } from "drizzle-orm";

import { toolById, toolLabel } from "@/lib/tools";
import { db } from "@/server/db";

import {
  CURATED_LIST,
  LIFT_SIGMA,
  liftStandardError,
  MIN_BAND,
  MIN_LIFT,
  MIN_STRONG_PREVALENCE,
  representatives,
  type Representative,
} from "./archetype";
import { EXTRACTOR_VERSION } from "./structure";

/**
 * Tool-level mining (Doc 7 RD.9, plan step P3) — does the tool axis discriminate?
 *
 * ## Measured before it is published, and this file is only the measurement
 *
 * Doc 7 §2 principle 4: every mined dimension starts as a probe that writes nothing, and only
 * a finding above the evidence gate reaches an author. `blocks-mine.ts` is the template and
 * says why in as many words — the moment a lift reaches `/build`, every draft in the product is
 * scaffolded from it, and that deserves its own miner version and changelog rather than
 * arriving as a side effect.
 *
 * So `pnpm archetypes --tools` prints this table and stores nothing. Whether the tool
 * dimension earns a place on the archetype is a decision to make *after* reading it.
 *
 * ## The bands, the reduction and the threshold are imported, never restated
 *
 * `representatives()`, `MIN_LIFT`, `LIFT_SIGMA` and `MIN_BAND` come from `archetype.ts`. Tool
 * lift and block lift and section lift are only comparable if they are the same arithmetic
 * over the same bands, and this codebase has twice produced a number that measured a gate with
 * something that was not the gate. A near-proxy that agreed to within a point would be worse
 * than an obvious disagreement, because nobody would notice it.
 *
 * ## What a tool lift would and would not mean
 *
 * It is a fact about what curated skills in a category *reach for*, and that is genuinely
 * useful to a reader choosing between skills. It is **not** advice to an author: a model told
 * that good review skills use `gh` will write `gh` into a skill for a team on GitLab. Doc 7
 * §4 RD.9 says outright that this dimension must never reach the generation prompt, and the
 * absence is asserted rather than promised.
 */

export type MeasuredTool = {
  tool: string;
  label: string;
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
  standardError: number;
  requiredLift: number;
  /** How many strong-band skills name it. The evidence behind the percentage. */
  strongCount: number;
  weakCount: number;
  kept: boolean;
  rejectedFor: string | null;
};

export type ToolMineResult = {
  category: string;
  structures: number;
  strongBand: number;
  weakBand: number;
  banded: boolean;
  /** Representatives with at least one resolved tool. Coverage for this category. */
  withTools: number;
  measured: MeasuredTool[];
};

const pct = (count: number, total: number) => (total === 0 ? 0 : Math.round((count / total) * 100));

/** Tool ids per version, for a set of representatives. One query, never one per skill. */
async function toolsByVersion(reps: readonly Representative[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (reps.length === 0) return out;
  const ids = reps.map((r) => r.skillVersionId);
  const { rows } = await db.execute<{ skill_version_id: string; tool: string }>(sql`
    select skill_version_id, tool
      from skill_tools
     where extractor_version = ${EXTRACTOR_VERSION}
       and skill_version_id = any(${sql`array[${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )}]`})
  `);
  for (const row of rows) {
    const set = out.get(row.skill_version_id) ?? new Set<string>();
    set.add(row.tool);
    out.set(row.skill_version_id, set);
  }
  return out;
}

function measure(
  tool: string,
  strong: readonly Representative[],
  weak: readonly Representative[],
  byVersion: Map<string, Set<string>>,
): MeasuredTool {
  const has = (r: Representative) => byVersion.get(r.skillVersionId)?.has(tool) ?? false;
  const strongCount = strong.filter(has).length;
  const weakCount = weak.filter(has).length;
  const strongPrevalence = pct(strongCount, strong.length);
  const weakPrevalence = pct(weakCount, weak.length);
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
    tool,
    label: toolLabel(tool),
    strongPrevalence,
    weakPrevalence,
    lift,
    standardError: Math.round(standardError * 100) / 100,
    requiredLift: Math.round(requiredLift * 10) / 10,
    strongCount,
    weakCount,
    kept: rejectedFor === null,
    rejectedFor,
  };
}

export async function mineToolLift(category: string): Promise<ToolMineResult | null> {
  const reps = await representatives(category);
  if (reps.length === 0) return null;

  const strong = reps.filter((r) => r.curated);
  const weak = reps.filter((r) => !r.curated);
  const byVersion = await toolsByVersion(reps);

  /*
   * Only tools some representative in this category actually names are measured.
   *
   * Running all 103 entries would print a hundred rows of zeros per category and bury the
   * finding — and a tool nobody in the category uses has nothing to say about it. The
   * vocabulary's own coverage is `verify:tools`' job, not this table's.
   */
  const present = new Set<string>();
  for (const set of byVersion.values()) for (const tool of set) present.add(tool);

  const measured = [...present]
    .map((tool) => measure(tool, strong, weak, byVersion))
    .sort((a, b) => b.lift - a.lift);

  return {
    category,
    structures: reps.length,
    strongBand: strong.length,
    weakBand: weak.length,
    banded: strong.length >= MIN_BAND && weak.length >= MIN_BAND,
    withTools: reps.filter((r) => (byVersion.get(r.skillVersionId)?.size ?? 0) > 0).length,
    measured,
  };
}

/** Corpus-wide: which tools separate the bands, and in how many categories. */
export async function toolLiftAcrossCategories(categories: readonly string[]): Promise<{
  examined: ToolMineResult[];
  banded: ToolMineResult[];
  byTool: Array<{
    tool: string;
    label: string;
    keptIn: number;
    bestLift: number;
    bestCategory: string | null;
    medianLift: number;
  }>;
}> {
  const examined: ToolMineResult[] = [];
  for (const category of categories) {
    const result = await mineToolLift(category);
    if (result) examined.push(result);
  }
  const banded = examined.filter((r) => r.banded);

  const tools = new Set<string>();
  for (const result of banded) for (const row of result.measured) tools.add(row.tool);

  const byTool = [...tools]
    .map((tool) => {
      const rows = banded
        .map((result) => result.measured.find((m) => m.tool === tool))
        .filter((m): m is MeasuredTool => m !== undefined);
      const lifts = rows.map((m) => m.lift).sort((a, b) => a - b);
      const best = rows.reduce<MeasuredTool | null>(
        (top, m) => (top === null || m.lift > top.lift ? m : top),
        null,
      );
      return {
        tool,
        label: toolLabel(tool),
        keptIn: rows.filter((m) => m.kept).length,
        bestLift: best?.lift ?? 0,
        bestCategory:
          banded.find((r) => r.measured.some((m) => m.tool === tool && m.lift === best?.lift))
            ?.category ?? null,
        medianLift: lifts.length === 0 ? 0 : lifts[Math.floor(lifts.length / 2)],
      };
    })
    .sort((a, b) => b.keptIn - a.keptIn || b.medianLift - a.medianLift);

  return { examined, banded, byTool };
}

/**
 * How many curated skills must name a tool before its guardrail share is quotable.
 *
 * A percentage over four documents is one document's opinion to two significant figures, and
 * this number is shown to an author as a reason to change their draft. The same argument the
 * loop panel makes for marking a share thin below ten sessions, and `MIN_DISTINCT_SKILLS`
 * makes for withholding archetype outcomes entirely.
 */
export const MIN_GUARDRAIL_EVIDENCE = 20;

/**
 * …and from how many distinct **repositories**, which is the gate that actually matters.
 *
 * The first run of this measurement reported `gcloud` at 86% over 37 skills — from **2
 * sources**. That is two repositories' house style quoted to an author as a corpus finding,
 * and it is R3.4's argument arriving in a new place: evidence is counted in distinct
 * structures, never skills, because one generator's clones are one data point. `aws` (4
 * sources) and `kubectl` (7) fell the same way.
 *
 * Ten, because below that a single prolific repository can carry the majority of a share that
 * is about to be shown to somebody as a reason to change their draft.
 */
export const MIN_GUARDRAIL_SOURCES = 10;

/**
 * How often curated skills that name a tool also carry a guardrail (Doc 7 RD.8's number).
 *
 * P2 marks a draft that names a destructive tool and states no constraint, and its sentence
 * reads correctly with no number at all — which is why P2 shipped without one. This supplies
 * it where the evidence supports it: *"92% of curated skills that name `git` carry a
 * guardrail; you have none"* is a far stronger sentence than the bare observation, and a
 * number below the gate is worse than none, so `null` is returned rather than a figure over
 * four skills.
 *
 * Curated band only, for the reason the block library ranks on source trust: the guidance and
 * its evidence have to come from the same population, or they are two different claims.
 */
export async function guardrailPrevalenceFor(
  tool: string,
): Promise<{ share: number; skills: number; sources: number } | null> {
  if (!toolById(tool)) return null;

  const { rows } = await db.execute<{ skills: number; sources: number; with_guardrail: number }>(sql`
    select count(*)::int as skills,
           count(distinct src.id)::int as sources,
           count(*) filter (where coalesce((st.block_counts->>'guardrail')::int, 0) > 0)::int as with_guardrail
      from skill_tools t
      join skills sk on sk.id = t.skill_id and sk.current_version_id = t.skill_version_id
      join skill_versions sv on sv.id = t.skill_version_id
      join sources src on src.id = sv.source_id
      join skill_structures st on st.skill_version_id = t.skill_version_id
       and st.extractor_version = ${EXTRACTOR_VERSION}
     where t.extractor_version = ${EXTRACTOR_VERSION}
       and t.tool = ${tool}
       and sk.status = 'indexed' and sk.org_id is null and sk.canonical_skill_id is null
       and lower(src.name) = any(string_to_array(${CURATED_LIST}, ','))
  `);

  const row = rows[0];
  if (!row || row.skills < MIN_GUARDRAIL_EVIDENCE || row.sources < MIN_GUARDRAIL_SOURCES) {
    return null;
  }
  return {
    share: Math.round((row.with_guardrail / row.skills) * 100),
    skills: row.skills,
    sources: row.sources,
  };
}

