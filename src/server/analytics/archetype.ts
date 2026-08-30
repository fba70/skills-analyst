import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/server/db";
import { EXTRACTOR_VERSION, type SectionRole } from "@/server/analytics/structure";

/**
 * Archetype mining (Doc 2 R3.2) — the core novel piece.
 *
 * ## An archetype is a contrast, not an average
 *
 * The obvious implementation averages a category and reports what it finds. It produces
 * something that looks like guidance and teaches nothing: a section present in 90% of good
 * skills *and* 90% of weak ones is not advice, it is a description of markdown. What an
 * author needs is the element that **distinguishes** the skills that work from the ones
 * that do not — present in 80% of the strong band and 30% of the weak one.
 *
 * So every element carries a `lift`: its prevalence in the strong band minus its prevalence
 * in the weak band. Positive lift is guidance. Near-zero lift is noise and is dropped,
 * however common the element. Negative lift is an anti-pattern, which is the same
 * measurement read the other way and costs nothing extra to produce.
 *
 * ## Counted in structures, never in skills
 *
 * Before anything is measured, the category is reduced to **one representative per distinct
 * document structure** — the highest-quality member of each. This is not an optimisation.
 * One repository once supplied 89% of this corpus with 85% of its skills sharing a single
 * generated skeleton; measured per skill, that generator's conventions would arrive as
 * near-universal truths with overwhelming statistical support. Measured per structure it is
 * one data point, which is what it is.
 *
 * The same reduction is why the R3.2 gate is `distinctStructures >= 50` across
 * `sources >= 10` rather than a skill count.
 *
 * ## Bands, not a median split
 *
 * Quartiles. The middle half of any category is unremarkable by construction and including
 * it just drags both bands toward the mean, flattening exactly the differences being looked
 * for. Comparing the top quarter against the bottom quarter is what makes a lift visible.
 */

export const MINER_VERSION = "1.0.0";

/** R3.2's gate, in the terms that actually resist a monoculture. */
export const MIN_STRUCTURES = 50;
export const MIN_SOURCES = 10;

/**
 * Minimum lift for an element to earn a place in the skeleton, in percentage points.
 *
 * Low enough to keep real signal on a few dozen representatives, high enough that sampling
 * noise does not become advice. Worth re-tuning against a bigger corpus — it is the one
 * number here that is a judgement rather than a measurement.
 */
const MIN_LIFT = 12;

/** An element has to exist somewhere before its lift means anything. */
const MIN_STRONG_PREVALENCE = 25;

type Representative = {
  skillId: string;
  slug: string;
  name: string;
  qualityScore: number;
  source: string;
  signature: string;
  roles: SectionRole[];
  /** Ordered role sequence as it appears in the document. */
  roleOrder: SectionRole[];
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  hasTemplates: boolean;
  fileCount: number;
  wordCount: number;
  codeBlockCount: number;
  tableCount: number;
  internalLinkCount: number;
  descriptionLength: number;
  descriptionShape: Record<string, unknown>;
  redistribution: string;
};

/**
 * One representative per distinct structure, best-quality first.
 *
 * `distinct on (signature)` with a quality-descending order is the whole de-duplication:
 * Postgres keeps the first row per signature, and ordering by score makes that the best
 * example of each shape rather than an arbitrary one.
 */
async function representatives(category: string): Promise<Representative[]> {
  const result = await db.execute(sql`
    with labelled as (
      select
        sk.id as skill_id,
        sk.slug,
        sk.name,
        sk.quality_score,
        src.name as source,
        sv.redistribution,
        st.section_roles,
        st.headings,
        st.has_scripts, st.has_references, st.has_assets, st.has_templates,
        st.file_count, st.word_count, st.code_block_count, st.table_count,
        st.internal_link_count, st.description_length, st.description_shape,
        (
          select coalesce(string_agg(h.role, '>' order by h.ord), '(none)')
          from jsonb_array_elements(st.headings) with ordinality as e(value, ord)
          cross join lateral (select e.value->>'role' as role, e.ord as ord) h
          where h.role is not null
        ) || ' @' || case
          when st.word_count >= 2000 then 'lg'
          when st.word_count >= 750 then 'md'
          else 'sm'
        end as signature
      from skill_categories c
      join skills sk on sk.id = c.skill_id
      join skill_versions sv on sv.id = sk.current_version_id
      join sources src on src.id = sv.source_id
      join skill_structures st on st.skill_version_id = sv.id
        and st.extractor_version = ${EXTRACTOR_VERSION}
      where c.axis = 'function'
        and c.value = ${category}
        and sk.status = 'indexed'
        and sk.canonical_skill_id is null
        and sk.quality_score is not null
    )
    select distinct on (signature) *
    from labelled
    order by signature, quality_score desc, skill_id
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    const headings = (row.headings ?? []) as Array<{ role: string | null }>;
    return {
      skillId: row.skill_id as string,
      slug: row.slug as string,
      name: row.name as string,
      qualityScore: row.quality_score as number,
      source: row.source as string,
      signature: row.signature as string,
      roles: ((row.section_roles ?? []) as SectionRole[]) ?? [],
      roleOrder: headings
        .map((h) => h.role)
        .filter((r): r is SectionRole => Boolean(r)),
      hasScripts: Boolean(row.has_scripts),
      hasReferences: Boolean(row.has_references),
      hasAssets: Boolean(row.has_assets),
      hasTemplates: Boolean(row.has_templates),
      fileCount: (row.file_count as number) ?? 1,
      wordCount: (row.word_count as number) ?? 0,
      codeBlockCount: (row.code_block_count as number) ?? 0,
      tableCount: (row.table_count as number) ?? 0,
      internalLinkCount: (row.internal_link_count as number) ?? 0,
      descriptionLength: (row.description_length as number) ?? 0,
      descriptionShape: (row.description_shape ?? {}) as Record<string, unknown>,
      redistribution: row.redistribution as string,
    };
  });
}

export type SkeletonSection = {
  role: SectionRole;
  /** Percent of strong-band structures carrying it. */
  strongPrevalence: number;
  weakPrevalence: number;
  /** strong − weak, in points. The reason this section is in the skeleton at all. */
  lift: number;
  /** Median position in document order among strong-band structures that have it. */
  typicalPosition: number;
  /** Present in nearly every strong example — treat as expected rather than optional. */
  required: boolean;
};

export type SkeletonTrait = {
  key: string;
  label: string;
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
};

export type Archetype = {
  category: string;
  skillCount: number;
  distinctStructures: number;
  sourceCount: number;
  strongThreshold: number;
  weakThreshold: number;
  meetsGate: boolean;
  gateReason: string | null;
  skeleton: {
    sections: SkeletonSection[];
    traits: SkeletonTrait[];
    norms: {
      medianWords: number;
      medianDescriptionLength: number;
      medianFileCount: number;
    };
  };
  antiPatterns: SkeletonTrait[];
  exemplars: Array<{ skillId: string; slug: string; name: string; qualityScore: number }>;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const pct = (count: number, total: number) => (total === 0 ? 0 : Math.round((count / total) * 100));

/** Boolean traits worth contrasting. Each is a decision an author actually makes. */
const TRAITS: Array<{ key: string; label: string; of: (r: Representative) => boolean }> = [
  { key: "has_scripts", label: "Ships executable scripts", of: (r) => r.hasScripts },
  { key: "has_references", label: "Offloads detail into references/", of: (r) => r.hasReferences },
  { key: "has_assets", label: "Bundles assets", of: (r) => r.hasAssets },
  { key: "has_templates", label: "Bundles templates", of: (r) => r.hasTemplates },
  { key: "multi_file", label: "More than one file", of: (r) => r.fileCount > 1 },
  { key: "code_examples", label: "Contains code examples", of: (r) => r.codeBlockCount > 0 },
  { key: "uses_tables", label: "Uses tables", of: (r) => r.tableCount > 0 },
  {
    key: "links_internally",
    label: "Links to its own bundled files",
    of: (r) => r.internalLinkCount > 0,
  },
  {
    key: "trigger_description",
    label: "Description names when to use it",
    of: (r) => r.descriptionShape.hasUseWhen === true,
  },
  {
    key: "imperative_description",
    label: "Description opens with a verb",
    of: (r) => r.descriptionShape.startsWithVerb === true,
  },
  {
    key: "concrete_description",
    label: "Description names concrete artifacts",
    of: (r) => r.descriptionShape.hasConcreteNoun === true,
  },
];

/** Skills in a category before de-duplication, for the collapse ratio. */
async function skillTotal(category: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as total
    from skill_categories c
    join skills sk on sk.id = c.skill_id
    join skill_versions sv on sv.id = sk.current_version_id
    join skill_structures st on st.skill_version_id = sv.id
      and st.extractor_version = ${EXTRACTOR_VERSION}
    where c.axis = 'function' and c.value = ${category}
      and sk.status = 'indexed' and sk.canonical_skill_id is null
      and sk.quality_score is not null
  `);
  return (result.rows[0] as { total: number } | undefined)?.total ?? 0;
}

export async function mineArchetype(category: string): Promise<Archetype | null> {
  const reps = await representatives(category);
  if (reps.length === 0) return null;

  // Kept beside `distinctStructures` because the gap between them is the interesting
  // number: 272 skills collapsing to 143 structures says something different about a
  // category than 272 collapsing to 12.
  const skillCount = await skillTotal(category);

  const sources = new Set(reps.map((r) => r.source));

  // Quartile bands. `Math.max(…, 1)` keeps a tiny category from producing empty bands and
  // dividing by zero — it will fail the gate anyway, but it should fail with numbers.
  const sorted = [...reps].sort((a, b) => b.qualityScore - a.qualityScore);
  const bandSize = Math.max(Math.floor(sorted.length / 4), 1);
  const strong = sorted.slice(0, bandSize);
  const weak = sorted.slice(-bandSize);

  const roleSet = new Set<SectionRole>();
  for (const rep of reps) for (const role of rep.roles) roleSet.add(role);

  const sections: SkeletonSection[] = [];
  for (const role of roleSet) {
    const strongCount = strong.filter((r) => r.roles.includes(role)).length;
    const weakCount = weak.filter((r) => r.roles.includes(role)).length;
    const strongPrevalence = pct(strongCount, strong.length);
    const weakPrevalence = pct(weakCount, weak.length);
    const lift = strongPrevalence - weakPrevalence;

    // The two rules that keep this prescriptive: it has to be common among good skills,
    // and it has to *distinguish* them. Either alone produces noise dressed as advice.
    if (strongPrevalence < MIN_STRONG_PREVALENCE || lift < MIN_LIFT) continue;

    const positions = strong
      .map((r) => r.roleOrder.indexOf(role))
      .filter((index) => index >= 0);

    sections.push({
      role,
      strongPrevalence,
      weakPrevalence,
      lift,
      typicalPosition: median(positions),
      required: strongPrevalence >= 80,
    });
  }

  sections.sort((a, b) => a.typicalPosition - b.typicalPosition || b.lift - a.lift);

  const traits: SkeletonTrait[] = [];
  const antiPatterns: SkeletonTrait[] = [];
  for (const trait of TRAITS) {
    const strongPrevalence = pct(strong.filter(trait.of).length, strong.length);
    const weakPrevalence = pct(weak.filter(trait.of).length, weak.length);
    const lift = strongPrevalence - weakPrevalence;
    const entry = { key: trait.key, label: trait.label, strongPrevalence, weakPrevalence, lift };

    if (lift >= MIN_LIFT) traits.push(entry);
    // The same measurement read backwards: a trait the weak band has and the strong band
    // does not is guidance about what to avoid, and it costs nothing extra to produce.
    else if (lift <= -MIN_LIFT) antiPatterns.push(entry);
  }
  traits.sort((a, b) => b.lift - a.lift);
  antiPatterns.sort((a, b) => a.lift - b.lift);

  /**
   * Exemplars (R3.3): high quality, and **licence-clean**.
   *
   * R1.6 is explicit that metadata-only skills are never reproduced in archetype
   * exemplars. An exemplar exists to be read in context by the builder, so listing one
   * whose text we may not redistribute would be an invitation to violate its licence.
   */
  const exemplars = strong
    .filter((r) => r.redistribution === "mirror_allowed" || r.redistribution === "attribution_required")
    .slice(0, 8)
    .map((r) => ({
      skillId: r.skillId,
      slug: r.slug,
      name: r.name,
      qualityScore: r.qualityScore,
    }));

  const meetsGate = reps.length >= MIN_STRUCTURES && sources.size >= MIN_SOURCES;
  const gateReason = meetsGate
    ? null
    : reps.length < MIN_STRUCTURES
      ? `${reps.length} distinct structures, needs ${MIN_STRUCTURES}`
      : `${sources.size} sources, needs ${MIN_SOURCES}`;

  return {
    category,
    skillCount,
    distinctStructures: reps.length,
    sourceCount: sources.size,
    strongThreshold: strong[strong.length - 1]?.qualityScore ?? 0,
    weakThreshold: weak[0]?.qualityScore ?? 0,
    meetsGate,
    gateReason,
    skeleton: {
      sections,
      traits,
      norms: {
        medianWords: median(strong.map((r) => r.wordCount)),
        medianDescriptionLength: median(
          strong.map((r) => r.descriptionLength).filter((n) => n > 0),
        ),
        medianFileCount: median(strong.map((r) => r.fileCount)),
      },
    },
    antiPatterns,
    exemplars,
  };
}
