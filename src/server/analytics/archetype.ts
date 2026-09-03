import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/server/db";
import { EXTRACTOR_VERSION, type SectionRole } from "@/server/analytics/structure";
import { SEED_REPOS } from "@/server/crawl/seeds";
import { REVIEW_FLOOR } from "@/server/taxonomy/vocabulary";

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
 * ## Bands come from source trust, not from the quality score
 *
 * The first version banded on `quality_score` quartiles and produced a confident, wrong
 * answer: it reported that good review skills are **single-file with no code examples**.
 *
 * The cause is worth recording because it is not obvious. The score is bounded at 100 and
 * most skills have no findings at all, so thousands sit at exactly 100 — the "top quartile"
 * is really "the subset of the 100s that sorting happened to pick". Anything that
 * systematically stops a skill reaching 100 is then, by construction, absent from the
 * strong band and reported as an anti-pattern. Every multi-file bundle picks up an
 * `orphaned-resources` note — severity `info`, one point, 2,293 occurrences — so **no
 * multi-file skill can score 100**, and "has more than one file" arrived as guidance. The
 * average actually runs the other way: 4+ file skills score 92.4 against 86.2 for
 * single-file ones.
 *
 * Raising the info weight to zero would remove that particular bias and make the ceiling
 * worse, since more skills would reach 100. The metric has no headroom at the top, and no
 * band drawn from it can have any either.
 *
 * Enriching the score with completeness signals — has a when-to-use section, has examples —
 * would be circular: the miner would then discover that good skills have the features we
 * scored them for, which is not a finding.
 *
 * So the bands come from something the miner does not measure at all: **who published the
 * skill**. The strong band is the curated seed allow-list — Anthropic, Stripe, Cloudflare,
 * Sentry, Trail of Bits, Hugging Face, Expo, and the high-signal community packs — and the
 * weak band is everything else. That is an independent judgement about craft, made by
 * people, before any of our analyzers ran. It is a proxy and it is imperfect (a long-tail
 * repository can be excellent), but it is honest about being a proxy, and unlike the score
 * it cannot be gamed by having less content.
 */

/**
 * 2.0.0 — bands moved from quality quartiles to source trust. See the note above.
 * 2.1.0 — the mine records **who it was derived from** (R3.4). Attribution is evidence,
 *   so it is pinned into the row beside the skeleton rather than recomputed at render
 *   time against a corpus that has moved on since the numbers were taken.
 * 2.2.0 — creation telemetry (R6.2) is an input. Section inclusion is decided on
 *   `lift + delta`, where the delta is bounded by R6.5 and null until a category clears the
 *   distinct-organisation floor. The loop closes here: what the corpus published and what
 *   authors kept are now both read, and kept separable so a reader can tell them apart.
 */
export const MINER_VERSION = "2.2.0";

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

/**
 * Members each band needs before a percentage over it is worth reading.
 *
 * Below this a single skill moves a lift by ten points or more, which is sampling noise
 * presented as advice.
 */
const MIN_BAND = 15;

/**
 * The curated set, derived from the seed allow-list rather than duplicated.
 *
 * A hand-copied list here would drift from `seeds.ts` the first time someone added a vendor
 * repository, and the drift would be invisible — the archetype would simply be mined from a
 * slightly wrong idea of which sources are trusted.
 *
 * ## Lower-cased on both sides, because the corpus holds the same repo under two casings
 *
 * GitHub treats `owner/repo` case-insensitively; our `sources` table does not, and 15 pairs
 * of rows differ only in case. `NVIDIA/skills` and `nvidia/skills` are one repository with
 * 268 and 99 indexed skills respectively — so an exact-match band lookup would have credited
 * one row and banded its twin as untrusted. That is a silent half-count of a curated source,
 * which is the failure mode this comment block exists to prevent one line above.
 */
const CURATED_SOURCES: ReadonlySet<string> = new Set(
  SEED_REPOS.map((seed) => seed.repo.toLowerCase()),
);

type Representative = {
  skillId: string;
  slug: string;
  name: string;
  qualityScore: number;
  source: string;
  sourceUrl: string | null;
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
  /** Published by a repository on the curated seed allow-list. The band selector. */
  curated: boolean;
};

/**
 * One representative per distinct structure, best-quality first.
 *
 * ## Only servable assignments count (R3.1)
 *
 * The confidence floor is enforced in the registry and in the denormalised
 * `skills.categories`, and was missing here — so archetypes were mined partly from labels
 * the classifier itself flagged as unreliable: **384 of 4,095** function assignments, and
 * 127 of 601 in `explain`. An archetype is a claim about what good skills in a category
 * look like, and a fifth of a category's evidence being guesswork does not blur that claim,
 * it makes it a claim about a different category.
 *
 * A curator-reviewed row counts whatever its score, because a human already decided. That
 * is the same rule `listSkills` applies, which is the point — the miner and the registry
 * must agree on what a category *contains*.
 *
 * (SQL comments below stay short: a backtick inside a `sql` template literal terminates it,
 * which is a genuinely confusing way to break a query.)
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
        src.url as source_url,
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
      -- Kept identical to gateEvidence below. See the note on that function.
      join skills sk on sk.id = c.skill_id
      join skill_versions sv on sv.id = sk.current_version_id
      join sources src on src.id = sv.source_id
      join skill_structures st on st.skill_version_id = sv.id
        and st.extractor_version = ${EXTRACTOR_VERSION}
      where c.axis = 'function'
        and c.value = ${category}
        -- Servable assignments only (R3.1). See the note above the function.
        and (c.confidence >= ${REVIEW_FLOOR} or c.reviewed_at is not null)
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
      sourceUrl: (row.source_url as string | null) ?? null,
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
      curated: CURATED_SOURCES.has(String(row.source ?? "").toLowerCase()),
    };
  });
}

/**
 * Per-category evidence, measured exactly the way the gate measures it.
 *
 * ## Why this is not `templates.ts`'s `categoryEvidence()`
 *
 * That function answers a neighbouring question and its numbers are close enough to look
 * interchangeable, which is the trap. Two differences make it a different measurement:
 *
 *   - it has **no size band** in the signature, so two skills with the same section roles
 *     and wildly different lengths collapse into one structure, where the miner counts two;
 *   - it does not filter `canonical_skill_id is null` or `quality_score is not null`, so it
 *     counts rows `representatives()` never sees.
 *
 * The errors run in opposite directions and roughly cancel — `automate-browser` reported 45
 * against the miner's 46 — which is exactly why substituting one for the other passes a
 * glance and fails on a category where they do not cancel.
 *
 * `pnpm taxonomy --status` used to answer "is this minable" with confident *skills*, which
 * announced `automate-browser` ready at 54 while the miner refused it at 46 structures.
 * Replacing that with a near-proxy would have swapped a visible contradiction for an
 * invisible one. So the status reads this, and this shares its `where` clause and its
 * signature expression with `representatives()` verbatim.
 *
 * `MIN_BAND` is not applied: the curated/other split belongs to `mineArchetype`, and a
 * status line is not worth a full mine per category. A category can clear this and still
 * fail on a thin band, which the miner reports when it happens.
 */
export async function gateEvidence(): Promise<
  Array<{ category: string; skills: number; structures: number; sources: number }>
> {
  const result = await db.execute(sql`
    with labelled as (
      select
        c.value as category,
        sk.id as skill_id,
        src.name as source,
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
        and (c.confidence >= ${REVIEW_FLOOR} or c.reviewed_at is not null)
        and sk.status = 'indexed'
        and sk.canonical_skill_id is null
        and sk.quality_score is not null
    )
    select category,
           count(distinct skill_id)::int as skills,
           count(distinct signature)::int as structures,
           count(distinct source)::int as sources
    from labelled
    group by category
    order by count(distinct signature) desc
  `);

  return result.rows as Array<{
    category: string;
    skills: number;
    structures: number;
    sources: number;
  }>;
}

/** What authoring taught us about a section (R6.2). Null until the bounds are cleared. */
export type SectionTelemetryRef = {
  drafts: number;
  orgs: number;
  survivalRate: number;
  firstPassRate: number;
  /** The bounded adjustment applied to `lift` when deciding inclusion (R6.5). */
  delta: number;
};

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
  /**
   * Authoring signal, kept **beside** the lift rather than folded into it (R6.2).
   *
   * The two measure different things — lift is what other people published, survival is
   * what happened when someone used this skeleton — and averaging them would produce a
   * number that answers neither question. Inclusion uses `lift + delta`; the page can show
   * both and say which is which.
   */
  telemetry: SectionTelemetryRef | null;
};

export type SkeletonTrait = {
  key: string;
  label: string;
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
};

/**
 * A source that contributed evidence to the mine (R3.4).
 *
 * Counted in **distinct structures**, exactly like the evidence gate. A generator that
 * supplied three hundred near-identical skills contributed one shape to this skeleton and
 * is credited with one — both the honest number and the one the mine actually used.
 */
export type Contributor = {
  /** `owner/repo`, as `sources.name` records it. */
  source: string;
  url: string | null;
  structures: number;
  /** In the curated band the skeleton is contrasted against, rather than merely present. */
  curated: boolean;
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
  /** The authoring signal this mine consumed, for the changelog and the page (R6.2). */
  telemetry: {
    drafts: number;
    orgs: number;
    withheldReason: string | null;
  };
  exemplars: Array<{ skillId: string; slug: string; name: string; qualityScore: number }>;
  /**
   * Every source behind the numbers above, best-represented first (R3.4).
   *
   * Not truncated. The point of crediting is that the whole list is available — a page can
   * show the first dozen and put the rest behind a disclosure, but the archetype should not
   * be the thing that decides who stops being credited.
   */
  contributors: Contributor[];
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const pct = (count: number, total: number) => (total === 0 ? 0 : Math.round((count / total) * 100));

/**
 * Who the evidence came from, in the unit the evidence is measured in.
 *
 * Runs over the representatives rather than the raw skills, so it credits a source for the
 * shapes it contributed. Reading it any other way would put the generator that supplied 89%
 * of the corpus at the top of every credit list while having taught the skeleton nothing.
 */
function contributorsOf(reps: Representative[]): Contributor[] {
  const bySource = new Map<string, Contributor>();
  for (const rep of reps) {
    const entry = bySource.get(rep.source);
    if (entry) entry.structures += 1;
    else {
      bySource.set(rep.source, {
        source: rep.source,
        url: rep.sourceUrl,
        structures: 1,
        curated: rep.curated,
      });
    }
  }
  return [...bySource.values()].sort(
    (a, b) => b.structures - a.structures || a.source.localeCompare(b.source),
  );
}

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
      -- Same floor as the representatives query, or the collapse ratio compares two
      -- different populations and reports a de-duplication that never happened.
      and (c.confidence >= ${REVIEW_FLOOR} or c.reviewed_at is not null)
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

  /**
   * Bands by publisher, not by score.
   *
   * Both sides need enough members for a percentage to mean anything. A category with three
   * curated structures would produce lifts of 33 points from a single skill, which is noise
   * wearing a number's clothes — it fails `meetsGate` below and is reported as ungated
   * rather than mined thin.
   */
  const strong = reps.filter((r) => r.curated);
  const weak = reps.filter((r) => !r.curated);

  const roleSet = new Set<SectionRole>();
  for (const rep of reps) for (const role of rep.roles) roleSet.add(role);

  /**
   * Creation telemetry (R6.2), if the category has cleared R6.5's bounds.
   *
   * Read once and applied per section below. `categoryTelemetry` has already deduplicated
   * per identity, rate-limited per organisation, trimmed the outliers and clamped the
   * delta — this function only has to decide what to do with a number it can trust to be
   * small.
   */
  const { categoryTelemetry } = await import("@/server/builder/telemetry");
  const telemetry = await categoryTelemetry(category);
  const signalFor = new Map(telemetry.sections.map((entry) => [entry.role, entry]));

  const sections: SkeletonSection[] = [];
  for (const role of roleSet) {
    const strongCount = strong.filter((r) => r.roles.includes(role)).length;
    const weakCount = weak.filter((r) => r.roles.includes(role)).length;
    const strongPrevalence = pct(strongCount, strong.length);
    const weakPrevalence = pct(weakCount, weak.length);
    const lift = strongPrevalence - weakPrevalence;

    const signal = signalFor.get(role) ?? null;

    /**
     * Inclusion is decided on lift **plus** the bounded authoring delta.
     *
     * This is the loop closing: a section the corpus is lukewarm about but that authors
     * consistently keep can cross the threshold, and one the corpus likes but authors
     * consistently delete can fall below it. `MAX_LIFT_DELTA` is five points, so telemetry
     * can move a borderline section and can never invent or erase one outright — which is
     * exactly the bounded-delta-per-cycle R6.5 asks for.
     */
    const effectiveLift = lift + (signal?.delta ?? 0);

    // The two rules that keep this prescriptive: it has to be common among good skills,
    // and it has to *distinguish* them. Either alone produces noise dressed as advice.
    if (strongPrevalence < MIN_STRONG_PREVALENCE || effectiveLift < MIN_LIFT) continue;

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
      telemetry: signal,
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
  const exemplars = [...strong]
    .filter(
      (r) => r.redistribution === "mirror_allowed" || r.redistribution === "attribution_required",
    )
    // Best-scoring first. The band is no longer sorted by quality, so this has to say so.
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, 8)
    .map((r) => ({
      skillId: r.skillId,
      slug: r.slug,
      name: r.name,
      qualityScore: r.qualityScore,
    }));

  const meetsGate =
    reps.length >= MIN_STRUCTURES &&
    sources.size >= MIN_SOURCES &&
    strong.length >= MIN_BAND &&
    weak.length >= MIN_BAND;

  const gateReason = meetsGate
    ? null
    : reps.length < MIN_STRUCTURES
      ? `${reps.length} distinct structures, needs ${MIN_STRUCTURES}`
      : sources.size < MIN_SOURCES
        ? `${sources.size} sources, needs ${MIN_SOURCES}`
        : strong.length < MIN_BAND
          ? `${strong.length} from curated sources, needs ${MIN_BAND}`
          : `${weak.length} from other sources, needs ${MIN_BAND}`;

  return {
    category,
    skillCount,
    distinctStructures: reps.length,
    sourceCount: sources.size,
    // Retained for transparency: the quality range each band happens to span. They no
    // longer *define* the bands — publisher does — but a reader comparing them can see
    // whether trust and score agree, which is itself informative.
    strongThreshold: Math.round(
      strong.reduce((sum, r) => sum + r.qualityScore, 0) / Math.max(strong.length, 1),
    ),
    weakThreshold: Math.round(
      weak.reduce((sum, r) => sum + r.qualityScore, 0) / Math.max(weak.length, 1),
    ),
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
    telemetry: {
      drafts: telemetry.drafts,
      orgs: telemetry.orgs,
      withheldReason: telemetry.withheldReason,
    },
    exemplars,
    contributors: contributorsOf(reps),
  };
}
