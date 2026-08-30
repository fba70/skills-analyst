import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/server/db";

import { EXTRACTOR_VERSION } from "./structure";

/**
 * Template clustering — how much *distinct structural knowledge* the corpus holds.
 *
 * ## Why this replaces the source-share number
 *
 * The first instrument for "is the corpus any good" was share-of-corpus per source, and it
 * flagged `mohitagw15856/pm-claude-skills` at 89%. That number was alarming and it was the
 * wrong measurement. Source concentration is a *proxy*: a large repository can be
 * structurally diverse, and a small one can be a thousand copies of a single skeleton.
 * Capping sources would have thrown away volume the foundry needs while leaving the actual
 * defect in place.
 *
 * The real defect is **structural monoculture**: many skills sharing one document skeleton.
 * That is what corrupts archetype mining, because an archetype is a claim about what good
 * skills in a category look like, and a skeleton repeated 1,985 times looks exactly like a
 * universal convention when you count skills. It is not one — it is one generator.
 *
 * So the number that matters is not "how many skills" but **how many distinct structures**,
 * and archetype evidence should be weighted per cluster rather than per skill.
 *
 * ## Not the same as near-duplicate detection
 *
 * `analytics/dedupe.ts` compares *text* with MinHash and correctly refuses to cluster these
 * — the 1,985 template siblings have genuinely different content: different names, different
 * descriptions, different subject matter. They are not duplicates and must not be collapsed
 * as if they were. They share a *shape*. Two orthogonal axes, two separate measurements, and
 * conflating them would either lose real skills or hide a real problem.
 *
 * ## The signature
 *
 * The ordered sequence of section roles, plus a coarse size band. Roles rather than heading
 * strings because that is already the normalisation archetypes are stated in; ordered
 * because section order is part of a skeleton; size-banded because a 200-word and a
 * 4,000-word document with the same sections are not the same template. Deliberately coarse:
 * the goal is to notice a generator, not to fingerprint every document uniquely.
 */

/** Size bands, in words. Coarse on purpose — see the note above. */
const SIZE_BANDS = [0, 250, 750, 2000, 5000] as const;

export function sizeBand(wordCount: number): string {
  for (let i = SIZE_BANDS.length - 1; i >= 0; i -= 1) {
    if (wordCount >= SIZE_BANDS[i]) {
      const next = SIZE_BANDS[i + 1];
      return next ? `${SIZE_BANDS[i]}-${next}w` : `${SIZE_BANDS[i]}w+`;
    }
  }
  return "0w";
}

/**
 * SQL for the structural signature of a `skill_structures` row.
 *
 * Built in SQL rather than in TypeScript so clustering is one grouped query over the whole
 * corpus instead of streaming every fingerprint into the app to hash it. The ordering
 * inside `jsonb_array_elements` follows document order, which is what `headings` stores.
 */
const SIGNATURE = sql`(
  select coalesce(string_agg(h.role, '>' order by h.ord), '(no sections)')
  from jsonb_array_elements(st.headings) with ordinality as e(value, ord)
  cross join lateral (select e.value->>'role' as role, e.ord as ord) h
  where h.role is not null
)`;

export type TemplateCluster = {
  signature: string;
  skills: number;
  /** Distinct sources the cluster spans. 1 means it is one generator, not a convention. */
  sources: number;
  sampleSlugs: string[];
  topSource: string | null;
};

export type TemplateReport = {
  fingerprinted: number;
  /** Distinct structures. This is the number archetype mining actually has to learn from. */
  distinctStructures: number;
  /**
   * Distinct structures as a share of skills, 0–100.
   *
   * The headline health number. 100 means every skill is structurally unique; a low value
   * means the corpus is mostly one generator wearing different names.
   */
  diversityPercent: number;
  /** Skills sitting inside a cluster of 10 or more — the monoculture mass. */
  inLargeClusters: number;
  clusters: TemplateCluster[];
};

export async function templateClusters(limit = 12): Promise<TemplateReport> {
  const result = await db.execute(sql`
    with sigs as (
      select st.skill_id,
             ${SIGNATURE} as signature,
             st.word_count,
             sk.slug,
             src.name as source
      from skill_structures st
      join skills sk on sk.id = st.skill_id
      join skill_versions sv on sv.id = st.skill_version_id
      join sources src on src.id = sv.source_id
      where st.extractor_version = ${EXTRACTOR_VERSION}
        and sk.status = 'indexed'
    ),
    banded as (
      select skill_id, slug, source,
             signature || ' @' || case
               when word_count >= 5000 then '5000w+'
               when word_count >= 2000 then '2000-5000w'
               when word_count >= 750  then '750-2000w'
               when word_count >= 250  then '250-750w'
               else '0-250w'
             end as signature
      from sigs
    ),
    grouped as (
      select signature,
             count(*)::int as skills,
             count(distinct source)::int as sources,
             (array_agg(slug order by slug))[1:3] as sample_slugs,
             mode() within group (order by source) as top_source
      from banded
      group by signature
    )
    select
      (select count(*)::int from banded) as fingerprinted,
      (select count(*)::int from grouped) as distinct_structures,
      (select coalesce(sum(skills), 0)::int from grouped where skills >= 10) as in_large_clusters,
      g.signature, g.skills, g.sources, g.sample_slugs, g.top_source
    from grouped g
    order by g.skills desc
    limit ${limit}
  `);

  const rows = result.rows as Array<{
    fingerprinted: number;
    distinct_structures: number;
    in_large_clusters: number;
    signature: string;
    skills: number;
    sources: number;
    sample_slugs: string[];
    top_source: string | null;
  }>;

  if (rows.length === 0) {
    return {
      fingerprinted: 0,
      distinctStructures: 0,
      diversityPercent: 0,
      inLargeClusters: 0,
      clusters: [],
    };
  }

  const fingerprinted = rows[0].fingerprinted;
  return {
    fingerprinted,
    distinctStructures: rows[0].distinct_structures,
    diversityPercent:
      fingerprinted > 0 ? Math.round((rows[0].distinct_structures / fingerprinted) * 100) : 0,
    inLargeClusters: rows[0].in_large_clusters,
    clusters: rows.map((row) => ({
      signature: row.signature,
      skills: row.skills,
      sources: row.sources,
      sampleSlugs: row.sample_slugs ?? [],
      topSource: row.top_source,
    })),
  };
}

/**
 * Per-source structural diversity — the honest version of "is this source noise?".
 *
 * A source contributing 900 skills across 400 distinct structures is carrying real
 * variety; one contributing 900 across 3 is a generator. Both look identical on a
 * share-of-corpus chart, which is precisely why that chart was the wrong instrument.
 *
 * This is the number to judge a large collection by before and after admitting it, and it
 * is a *reporting* signal: nothing here rejects a source. Deciding what to do about a
 * monoculture — down-weight it in mining, leave it for search, drop it — is a curator's
 * call, and the archetype weighting handles the common case on its own.
 */
export async function sourceDiversity(limit = 15) {
  const result = await db.execute(sql`
    with sigs as (
      select src.name as source,
             ${SIGNATURE} as signature
      from skill_structures st
      join skills sk on sk.id = st.skill_id
      join skill_versions sv on sv.id = st.skill_version_id
      join sources src on src.id = sv.source_id
      where st.extractor_version = ${EXTRACTOR_VERSION}
        and sk.status = 'indexed'
    )
    select source,
           count(*)::int as skills,
           count(distinct signature)::int as structures,
           round(100.0 * count(distinct signature) / nullif(count(*), 0))::int as diversity
    from sigs
    group by source
    having count(*) >= 5
    order by count(*) desc
    limit ${limit}
  `);

  return result.rows as Array<{
    source: string;
    skills: number;
    structures: number;
    diversity: number;
  }>;
}

/**
 * How much evidence a function category really has, once clones stop being counted twice.
 *
 * `R3.2` gates an archetype on ≥50 validated skills in a category. Counting raw skills
 * would have let one generator clear that bar alone, and the resulting archetype would
 * describe that generator. So the gate reads `distinctStructures`, and `skills` is kept
 * beside it to make the gap visible.
 */
export async function categoryEvidence() {
  const result = await db.execute(sql`
    with sigs as (
      select c.value as category,
             ${SIGNATURE} as signature,
             sk.id as skill_id,
             src.name as source
      from skill_categories c
      join skills sk on sk.id = c.skill_id
      join skill_structures st on st.skill_id = sk.id
        and st.extractor_version = ${EXTRACTOR_VERSION}
      join skill_versions sv on sv.id = st.skill_version_id
      join sources src on src.id = sv.source_id
      where c.axis = 'function'
        and sk.status = 'indexed'
    )
    select category,
           count(distinct skill_id)::int as skills,
           count(distinct signature)::int as structures,
           count(distinct source)::int as sources
    from sigs
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
