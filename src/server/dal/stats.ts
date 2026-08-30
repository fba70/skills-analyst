import "server-only";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { archetypes, skills, skillVersions, sources } from "@/server/db/schema";
import { withOrgScope, withPublicScope } from "@/server/dal/scope";
import { FUNCTIONS } from "@/server/taxonomy/vocabulary";

/**
 * Corpus statistics for the ordinary user (Doc 2 R8.5).
 *
 * Doc 2 covers two audiences and misses a third. Operators get source health (R1.7) and
 * loop observability (R6.4); researchers get a dataset export (R3.7); a person who just
 * wants to know whether this registry is worth trusting gets nothing. That is what this is.
 *
 * The numbers are chosen for the question that person is actually asking — *how much is
 * here, how good is it, and how much can I use* — which is a different question from the
 * one an operator asks. Queue depth and rate-limit headroom do not belong here; licence mix
 * does, because it decides whether a search result can be downloaded at all.
 *
 * Everything is computed on request. The aggregates are cheap at this size and staying with
 * live queries means the dashboard cannot quietly show a stale picture, which for a
 * freshness metric would be self-defeating. A materialised view is the answer if this ever
 * gets slow, not before.
 */

export type PlatformStats = {
  /** Canonical, indexed, servable. The number that means "skills you can browse". */
  indexed: number;
  /** Held back by validation. Visible on their own pages, excluded from search. */
  quarantined: number;
  /** Withdrawn upstream; metadata kept (R1.5). */
  tombstoned: number;
  /** Near-duplicates folded under a canonical entry (R1.4). */
  variants: number;
  sources: number;
  /** Sources that have completed at least one sync. */
  sourcesSynced: number;
  /** Share of judged versions that passed, 0–100. */
  passRate: number;
  /** Skills whose bundle we may serve — see `licenceMix`. */
  downloadable: number;
  licenceMix: Array<{ posture: string; count: number }>;
  qualityBands: Array<{ band: string; count: number }>;
  /** Function categories with a mined archetype (R3.2), and how many there could be. */
  archetypeCategories: number;
  functionCategories: number;
  /**
   * Distinct document structures those archetypes were derived from.
   *
   * Structures, not skills, because that is the unit the mine measures in — one generator's
   * three hundred clones are one data point. Quoting a skill count here would inflate the
   * evidence by exactly the factor the miner exists to divide out.
   */
  archetypeStructures: number;
  /** Most recent successful sync of any source. */
  lastSyncAt: Date | null;
  /** Hours since that sync — R7.4 targets a full resync inside 24h. */
  hoursSinceSync: number | null;
};

/** Postures whose bytes may be handed over. Mirrors `skills/export.ts`. */
const SERVABLE = ["mirror_allowed", "attribution_required"] as const;

export async function platformStats(): Promise<PlatformStats> {
  return withPublicScope(async (tx) => {
    const [counts] = await tx
      .select({
        indexed: sql<number>`count(*) filter (where ${skills.status} = 'indexed' and ${skills.canonicalSkillId} is null)::int`,
        quarantined: sql<number>`count(*) filter (where ${skills.status} = 'quarantined')::int`,
        tombstoned: sql<number>`count(*) filter (where ${skills.status} = 'tombstoned')::int`,
        variants: sql<number>`count(*) filter (where ${skills.canonicalSkillId} is not null)::int`,
      })
      .from(skills);

    const [sourceCounts] = await tx
      .select({
        total: sql<number>`count(*) filter (where ${sources.kind} <> 'awesome_list')::int`,
        synced: sql<number>`count(*) filter (where ${sources.lastSuccessAt} is not null)::int`,
        lastSyncAt: sql<Date | null>`max(${sources.lastSuccessAt})`,
      })
      .from(sources);

    // Pass rate over *judged* versions only. Including pending ones would make the number
    // move whenever a sync lands, which says nothing about validation quality.
    const [judged] = await tx
      .select({
        passed: sql<number>`count(*) filter (where ${skillVersions.status} = 'indexed')::int`,
        total: sql<number>`count(*) filter (where ${skillVersions.status} in ('indexed', 'quarantined'))::int`,
      })
      .from(skillVersions);

    const licence = await tx
      .select({
        posture: skillVersions.redistribution,
        count: sql<number>`count(*)::int`,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .where(and(eq(skills.status, "indexed"), isNull(skills.canonicalSkillId)))
      .groupBy(skillVersions.redistribution)
      .orderBy(desc(sql`count(*)`));

    /**
     * Quality in bands, not a mean.
     *
     * An average score over thousands of skills is a number nobody can act on — it moves by
     * a point a week and says nothing about whether the good ones are good. Bands answer
     * the question a reader has: is most of this solid, or is it a long tail of near-misses?
     */
    const quality = await tx
      .select({
        band: sql<string>`case
          when ${skills.qualityScore} >= 90 then '90-100'
          when ${skills.qualityScore} >= 75 then '75-89'
          when ${skills.qualityScore} >= 50 then '50-74'
          else 'under 50'
        end`,
        count: sql<number>`count(*)::int`,
      })
      .from(skills)
      .where(
        and(
          eq(skills.status, "indexed"),
          isNull(skills.canonicalSkillId),
          isNotNull(skills.qualityScore),
        ),
      )
      .groupBy(sql`1`);

    /**
     * The latest archetype per category, counted and summed in one pass.
     *
     * `distinct on (category)` with a version-descending order keeps the newest row per
     * category — archetypes are append-only, so every previous version is still in the
     * table and a plain `count(*)` would report how many times we have mined rather than
     * how many categories are covered.
     *
     * `org_id is null` is explicit: a Team-tier archetype mined from a private corpus must
     * never be counted into a public statistic. RLS would already do it here, but this
     * number ends up on the front door, and OQ-C2's default belongs where someone can see
     * it rather than only in a policy on a table.
     */
    const [archetypeTotals] = await tx
      .select({
        categories: sql<number>`count(*)::int`,
        structures: sql<number>`coalesce(sum(t.distinct_structures), 0)::int`,
      })
      .from(
        sql`(
          select distinct on (${archetypes.category})
            ${archetypes.category} as category,
            ${archetypes.distinctStructures} as distinct_structures
          from ${archetypes}
          where ${archetypes.axis} = 'function' and ${archetypes.orgId} is null
          order by ${archetypes.category}, ${archetypes.version} desc
        ) t`,
      );

    const downloadable = licence
      .filter((row) => (SERVABLE as readonly string[]).includes(row.posture))
      .reduce((total, row) => total + row.count, 0);

    const lastSyncAt = sourceCounts.lastSyncAt ? new Date(sourceCounts.lastSyncAt) : null;

    const order = ["90-100", "75-89", "50-74", "under 50"];
    return {
      indexed: counts.indexed,
      quarantined: counts.quarantined,
      tombstoned: counts.tombstoned,
      variants: counts.variants,
      sources: sourceCounts.total,
      sourcesSynced: sourceCounts.synced,
      passRate: judged.total > 0 ? Math.round((judged.passed / judged.total) * 100) : 0,
      downloadable,
      licenceMix: licence,
      qualityBands: quality.sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band)),
      archetypeCategories: archetypeTotals?.categories ?? 0,
      functionCategories: FUNCTIONS.length,
      archetypeStructures: archetypeTotals?.structures ?? 0,
      lastSyncAt,
      hoursSinceSync: lastSyncAt
        ? Math.floor((Date.now() - lastSyncAt.getTime()) / 3_600_000)
        : null,
    };
  });
}

export type MySkill = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  status: string;
  qualityScore: number | null;
  updatedAt: Date;
};

/**
 * Skills belonging to the caller's organisation.
 *
 * Empty for everyone today: nothing writes an org-scoped skill, because the builder (R4.x)
 * does not exist yet. It is queried rather than stubbed so the dashboard is wired to the
 * real thing from the start — when the builder lands, this fills in with no change here.
 *
 * `withOrgScope` is doing the work: it resolves the org from the session and RLS filters to
 * it, so this cannot return another tenant's skills even if the `where` below were wrong.
 */
export async function mySkills(limit = 10): Promise<MySkill[]> {
  return withOrgScope(async (tx) => {
    return tx
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        summary: skills.summary,
        status: skills.status,
        qualityScore: skills.qualityScore,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(isNotNull(skills.orgId))
      .orderBy(desc(skills.updatedAt))
      .limit(limit);
  });
}
