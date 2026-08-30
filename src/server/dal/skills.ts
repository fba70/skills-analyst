import "server-only";

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import {
  capabilitySurfaces,
  skillCategories,
  skillDuplicates,
  skills,
  skillVersions,
  sources,
  verdicts,
} from "@/server/db/schema";
import { capabilityLabel } from "@/lib/capabilities";
import { withOrgScope } from "@/server/dal/scope";
import { labelFor, REVIEW_FLOOR, type CategoryAxis } from "@/server/taxonomy/vocabulary";

/**
 * Reads for the registry.
 *
 * Everything goes through `withOrgScope`, so each query runs inside a transaction that
 * has declared which org is asking. Public-corpus rows carry `org_id IS NULL` and are
 * visible to everyone; a tenant's private skills only inside their own session. No query
 * here takes an org id as an argument — that is the DAL rule.
 *
 * Filtering, sorting, counting and paging all happen in SQL. Fetching every row and
 * slicing it in the page would work at 19 skills and fall over at 100,000, and the
 * search latency budget (p95 < 500 ms at 500K skills, R7.4) is set against the database
 * doing this work, not the server.
 *
 * Ranking rule from Doc 2 R2.9: popularity never outranks a failed or unscored skill.
 * Only skills with a *passing* current version are listed at all, and quality leads
 * every sort except the explicitly-chosen ones.
 */

export const PAGE_SIZES = [5, 10, 25] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 10;

export const SORTS = {
  quality: "Quality",
  name: "Name",
  stars: "Stars",
  recent: "Recently synced",
} as const;
export type SortKey = keyof typeof SORTS;

export type SkillFilters = {
  query?: string;
  /** `sources.id` */
  source?: string;
  dialect?: string;
  /** `redistribution` posture */
  posture?: string;
  /** Only skills whose bundled code touches this capability. */
  capability?: string;
  /** A category slug from either axis (R3.1) — `function:review`, `domain:marketing`. */
  category?: string;
  sort?: SortKey;
  page?: number;
  pageSize?: PageSize;
};

export type SkillListItem = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  dialect: string;
  qualityScore: number | null;
  licenseSpdx: string | null;
  redistribution: string;
  contentStored: boolean;
  sourceName: string | null;
  stars: number | null;
  /** Near-duplicates clustered under this entry. */
  variantCount: number;
  /** Servable category assignments, both axes (R3.1). */
  categories: Array<{ axis: string; value: string }>;
};

export type SkillListPage = {
  items: SkillListItem[];
  total: number;
  page: number;
  pageSize: PageSize;
  pageCount: number;
};

export type FilterOptions = {
  sources: Array<{ value: string; label: string; count: number }>;
  dialects: Array<{ value: string; label: string; count: number }>;
  postures: Array<{ value: string; label: string; count: number }>;
  capabilities: Array<{ value: string; label: string; count: number }>;
  /** Both axes, each entry keyed `axis:value` so one control can serve both. */
  functions: Array<{ value: string; label: string; count: number }>;
  domains: Array<{ value: string; label: string; count: number }>;
  total: number;
  mirrored: number;
};

/** Variants clustered under a skill. Prefixes spelled out, as with latestSignal. */
function variantCount() {
  return sql<number>`(
    select count(*)::int from "skills" v where v."canonical_skill_id" = "skills"."id"
  )`;
}

/**
 * Latest reading per signal kind, as a correlated scalar subquery.
 *
 * Table prefixes are spelled out rather than interpolated: Drizzle drops qualification on
 * single-table selects, and an unqualified `"id"` inside this subquery binds to
 * `skill_signals.id` instead of `skills.id`. It happens to work here because the outer
 * query has joins and is therefore qualified — which is exactly the kind of accident that
 * breaks the moment a join is removed.
 */
function latestSignal(kind: "stars") {
  return sql<number | null>`(
    select "skill_signals"."value"::int
    from "skill_signals"
    where "skill_signals"."skill_id" = "skills"."id"
      and "skill_signals"."kind" = ${kind}
    order by "skill_signals"."observed_at" desc
    limit 1
  )`;
}

/**
 * Every filter that is set, ANDed. Two of these are floors, not filters:
 *
 *   - `indexed` — nothing unvalidated is ever listed;
 *   - `canonical_skill_id IS NULL` — a variant is not a separate result. 987 of 2,531
 *     skills are near-duplicates of another, and listing them would mean 66 copies of
 *     `agent-hiring-panel` crowding out everything else. The variants keep their rows,
 *     their provenance and their attribution; they are reachable from the canonical
 *     entry, not alongside it (Doc 2 R1.4).
 */
function whereFor(filters: SkillFilters): SQL | undefined {
  const clauses: Array<SQL | undefined> = [
    eq(skills.status, "indexed"),
    isNull(skills.canonicalSkillId),
  ];

  const search = filters.query?.trim();
  if (search) {
    clauses.push(
      or(
        ilike(skills.name, `%${search}%`),
        ilike(skills.summary, `%${search}%`),
        ilike(skills.slug, `%${search}%`),
      ),
    );
  }
  if (filters.source) clauses.push(eq(skillVersions.sourceId, filters.source));
  if (filters.dialect) {
    clauses.push(eq(skills.dialect, filters.dialect as typeof skills.dialect.enumValues[number]));
  }
  if (filters.posture) {
    clauses.push(
      eq(
        skillVersions.redistribution,
        filters.posture as typeof skillVersions.redistribution.enumValues[number],
      ),
    );
  }
  if (filters.category) {
    // `axis:value`, so one query parameter serves both axes without a second control.
    // Only *servable* assignments filter: a held low-confidence guess should not silently
    // decide what a user sees, which is the whole reason the review floor exists.
    const [axis, ...rest] = filters.category.split(":");
    const value = rest.join(":");
    if (axis && value) {
      clauses.push(sql`exists (
        select 1 from ${skillCategories} sc
        where sc.skill_id = ${skills.id}
          and sc.axis = ${axis}
          and sc.value = ${value}
          and (sc.confidence >= ${REVIEW_FLOOR} or sc.reviewed_at is not null)
      )`);
    }
  }
  if (filters.capability) {
    // The surface is jsonb: `{ network: { present: true, evidence: [...] }, ... }`.
    clauses.push(sql`exists (
      select 1 from ${capabilitySurfaces} cs
      where cs.skill_version_id = ${skillVersions.id}
        and cs.surface -> ${filters.capability} ->> 'present' = 'true'
    )`);
  }

  return and(...clauses.filter(Boolean));
}

function orderFor(sort: SortKey | undefined) {
  switch (sort) {
    case "name":
      return [asc(skills.name)];
    case "stars":
      // Quality still breaks ties, so popularity cannot promote a weak skill past a
      // strong one at the same star count.
      return [desc(latestSignal("stars")), desc(skills.qualityScore)];
    case "recent":
      return [desc(skillVersions.syncedAt), desc(skills.qualityScore)];
    default:
      return [desc(skills.qualityScore), asc(skills.name)];
  }
}

export async function listSkills(filters: SkillFilters = {}): Promise<SkillListPage> {
  const pageSize = (PAGE_SIZES as readonly number[]).includes(filters.pageSize ?? 0)
    ? (filters.pageSize as PageSize)
    : DEFAULT_PAGE_SIZE;
  const where = whereFor(filters);

  return withOrgScope(async (tx) => {
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .where(where);

    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    // Clamp rather than 404: a filter change can drop the page count below the page the
    // user was on, and landing on an empty page reads as "nothing found".
    const page = Math.min(Math.max(1, filters.page ?? 1), pageCount);

    const items = await tx
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        summary: skills.summary,
        dialect: skills.dialect,
        qualityScore: skills.qualityScore,
        licenseSpdx: skillVersions.licenseSpdx,
        redistribution: skillVersions.redistribution,
        contentStored: skillVersions.contentStored,
        sourceName: sources.name,
        stars: latestSignal("stars"),
        variantCount: variantCount(),
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .leftJoin(sources, eq(sources.id, skillVersions.sourceId))
      .where(where)
      .orderBy(...orderFor(filters.sort))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    /**
     * Categories for the visible page only.
     *
     * One extra query keyed on the ids just fetched, rather than a join on the main
     * select: a skill carries up to five assignments across two axes, and joining would
     * multiply every row by that and break the `limit`. Ten rows in, ten rows out.
     */
    const categoryRows =
      items.length === 0
        ? []
        : await tx
            .select({
              skillId: skillCategories.skillId,
              axis: skillCategories.axis,
              value: skillCategories.value,
            })
            .from(skillCategories)
            .where(
              and(
                inArray(
                  skillCategories.skillId,
                  items.map((item) => item.id),
                ),
                sql`(${skillCategories.confidence} >= ${REVIEW_FLOOR} or ${skillCategories.reviewedAt} is not null)`,
              ),
            )
            .orderBy(desc(skillCategories.confidence));

    const bySkill = new Map<string, Array<{ axis: string; value: string }>>();
    for (const row of categoryRows) {
      const list = bySkill.get(row.skillId) ?? [];
      list.push({ axis: row.axis, value: row.value });
      bySkill.set(row.skillId, list);
    }

    return {
      items: items.map((item) => ({ ...item, categories: bySkill.get(item.id) ?? [] })),
      total,
      page,
      pageSize,
      pageCount,
    };
  });
}

/**
 * The values worth filtering by, with counts.
 *
 * Counts are unfiltered on purpose: a facet that shows "0" is useful information, and
 * recomputing every facet against every other facet's selection is a lot of query for
 * very little at this corpus size.
 */
export async function getFilterOptions(): Promise<FilterOptions> {
  return withOrgScope(async (tx) => {
    const base = tx
      .select({
        sourceId: skillVersions.sourceId,
        sourceName: sources.name,
        dialect: skills.dialect,
        posture: skillVersions.redistribution,
        contentStored: skillVersions.contentStored,
        versionId: skillVersions.id,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .leftJoin(sources, eq(sources.id, skillVersions.sourceId))
      .where(and(eq(skills.status, "indexed"), isNull(skills.canonicalSkillId)));

    const rows = await base;

    const tally = <T extends string>(values: T[]) => {
      const counts = new Map<T, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    };

    const sourceCounts = tally(rows.map((row) => `${row.sourceId} ${row.sourceName ?? ""}`));
    const dialectCounts = tally(rows.map((row) => row.dialect));
    const postureCounts = tally(rows.map((row) => row.posture));

    const capabilityRows = await tx
      .select({
        surface: capabilitySurfaces.surface,
      })
      .from(capabilitySurfaces)
      .where(
        inArray(
          capabilitySurfaces.skillVersionId,
          rows.map((row) => row.versionId),
        ),
      );

    /**
     * Category facets, per axis (R3.1).
     *
     * Counted from servable assignments only — a held low-confidence guess must not
     * advertise a category in the sidebar and then return a different set of results.
     */
    const categoryRows = await tx
      .select({
        axis: skillCategories.axis,
        value: skillCategories.value,
        count: sql<number>`count(*)::int`,
      })
      .from(skillCategories)
      .innerJoin(skills, eq(skills.id, skillCategories.skillId))
      .where(
        and(
          eq(skills.status, "indexed"),
          isNull(skills.canonicalSkillId),
          sql`(${skillCategories.confidence} >= ${REVIEW_FLOOR} or ${skillCategories.reviewedAt} is not null)`,
        ),
      )
      .groupBy(skillCategories.axis, skillCategories.value)
      .orderBy(desc(sql`count(*)`));

    const facet = (axis: CategoryAxis) =>
      categoryRows
        .filter((row) => row.axis === axis)
        .map((row) => ({
          value: `${axis}:${row.value}`,
          label: labelFor(axis, row.value),
          count: row.count,
        }));

    const capabilityCounts = new Map<string, number>();
    for (const row of capabilityRows) {
      const surface = (row.surface ?? {}) as Record<string, { present?: boolean }>;
      for (const [key, value] of Object.entries(surface)) {
        if (value?.present) capabilityCounts.set(key, (capabilityCounts.get(key) ?? 0) + 1);
      }
    }

    const label = (value: string) => value.replace(/_/g, " ");

    return {
      sources: [...sourceCounts.entries()]
        .map(([composite, count]) => {
          const [value, name] = composite.split(" ");
          return { value, label: name || value, count };
        })
        .sort((a, b) => b.count - a.count),
      dialects: [...dialectCounts.entries()]
        .map(([value, count]) => ({ value, label: label(value), count }))
        .sort((a, b) => b.count - a.count),
      postures: [...postureCounts.entries()]
        .map(([value, count]) => ({ value, label: label(value), count }))
        .sort((a, b) => b.count - a.count),
      capabilities: [...capabilityCounts.entries()]
        // Shared with the detail page's capability card, so the registry filter and the
        // skill page cannot disagree about what `fs_read` is called.
        .map(([value, count]) => ({ value, label: capabilityLabel(value), count }))
        .sort((a, b) => b.count - a.count),
      functions: facet("function"),
      domains: facet("domain"),
      total: rows.length,
      mirrored: rows.filter((row) => row.contentStored).length,
    };
  });
}

export type SkillDetail = SkillListItem & {
  status: string;
  versionId: string;
  contentHash: string;
  fileCount: number | null;
  byteSize: number | null;
  frontmatter: Record<string, unknown>;
  provenance: Record<string, unknown>;
  licenseSource: string;
  licenseEvidence: Record<string, unknown> | null;
  sourceUrl: string | null;
  syncedAt: Date;
  verdicts: Array<{
    analyzer: string;
    analyzerVersion: string;
    result: string;
    severity: string;
    findings: Array<{
      reason: string;
      severity: string;
      message: string;
      file?: string;
      line?: number;
      excerpt?: string;
    }>;
    /**
     * The analyzer's structured output — capability surface, consistency score, and
     * whatever a later analyzer chooses to record.
     *
     * Carried through rather than flattened because each analyzer's payload has its own
     * shape, and the renderer that understands one should read it directly instead of the
     * DAL guessing a common denominator.
     */
    data: Record<string, unknown>;
  }>;
  capabilities: string[];
  undocumented: string[];
  surface: Record<string, { present: boolean; evidence: string[] }>;
  /** Near-duplicates clustered under this skill, with the similarity that grouped them. */
  variants: Array<{
    id: string;
    slug: string;
    name: string;
    sourceName: string | null;
    similarity: number;
  }>;
  /** Set when THIS skill is itself a variant of another. */
  canonicalOf: { slug: string; name: string; similarity: number } | null;
};

export async function getSkillBySlug(slug: string): Promise<SkillDetail | null> {
  return withOrgScope(async (tx) => {
    const [row] = await tx
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        summary: skills.summary,
        dialect: skills.dialect,
        status: skills.status,
        qualityScore: skills.qualityScore,
        versionId: skillVersions.id,
        contentHash: skillVersions.contentHash,
        contentStored: skillVersions.contentStored,
        fileCount: skillVersions.fileCount,
        byteSize: skillVersions.byteSize,
        frontmatter: skillVersions.frontmatter,
        provenance: skillVersions.provenance,
        licenseSpdx: skillVersions.licenseSpdx,
        licenseSource: skillVersions.licenseSource,
        licenseEvidence: skillVersions.licenseEvidence,
        redistribution: skillVersions.redistribution,
        syncedAt: skillVersions.syncedAt,
        sourceName: sources.name,
        sourceUrl: sources.url,
        stars: latestSignal("stars"),
        variantCount: variantCount(),
        canonicalSkillId: skills.canonicalSkillId,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .leftJoin(sources, eq(sources.id, skillVersions.sourceId))
      .where(eq(skills.slug, slug))
      /**
       * Slugs are NOT unique in the public corpus.
       *
       * The unique index is on `(org_id, slug)`, and Postgres treats NULLs as distinct —
       * so every public skill named `agent-hiring-panel` (66 of them) coexists. Without
       * an order this resolved to an arbitrary copy, usually a variant, which then showed
       * neither its cluster nor its parent.
       *
       * Canonical first, then quality: a slug URL should land on the entry the registry
       * actually lists.
       */
      // NULLS FIRST is the whole point: a canonical skill has canonical_skill_id NULL,
      // and Postgres sorts NULLs LAST on ASC by default — which would prefer variants.
      .orderBy(
        sql`${skills.canonicalSkillId} asc nulls first`,
        desc(skills.qualityScore),
        asc(skills.firstSeenAt),
      )
      .limit(1);

    if (!row) return null;

    const verdictRows = await tx
      .select({
        analyzer: verdicts.analyzer,
        analyzerVersion: verdicts.analyzerVersion,
        result: verdicts.result,
        severity: verdicts.severity,
        evidence: verdicts.evidence,
        createdAt: verdicts.createdAt,
      })
      .from(verdicts)
      .where(eq(verdicts.skillVersionId, row.versionId))
      .orderBy(desc(verdicts.createdAt));

    // Append-only: keep only the newest verdict per analyzer.
    const newest = new Map<string, (typeof verdictRows)[number]>();
    for (const verdict of verdictRows) {
      if (!newest.has(verdict.analyzer)) newest.set(verdict.analyzer, verdict);
    }

    const [surfaceRow] = await tx
      .select({
        surface: capabilitySurfaces.surface,
        undocumented: capabilitySurfaces.undocumented,
      })
      .from(capabilitySurfaces)
      .where(eq(capabilitySurfaces.skillVersionId, row.versionId))
      .orderBy(desc(capabilitySurfaces.createdAt))
      .limit(1);

    const surface =
      (surfaceRow?.surface as Record<string, { present: boolean; evidence: string[] }>) ?? {};

    const variantRows = await tx
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        sourceName: sources.name,
        similarity: skillDuplicates.similarity,
      })
      .from(skillDuplicates)
      .innerJoin(skills, eq(skills.id, skillDuplicates.duplicateSkillId))
      .leftJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
      .leftJoin(sources, eq(sources.id, skillVersions.sourceId))
      .where(eq(skillDuplicates.canonicalSkillId, row.id))
      .orderBy(desc(skillDuplicates.similarity))
      .limit(50);

    // Servable category assignments, both axes (R3.1). Held low-confidence guesses are
    // excluded: a category nobody has confirmed should not be presented as a fact about
    // the skill on its own page.
    const categoryRows = await tx
      .select({ axis: skillCategories.axis, value: skillCategories.value })
      .from(skillCategories)
      .where(
        and(
          eq(skillCategories.skillId, row.id),
          sql`(${skillCategories.confidence} >= ${REVIEW_FLOOR} or ${skillCategories.reviewedAt} is not null)`,
        ),
      )
      .orderBy(desc(skillCategories.confidence));

    // When this skill is itself a variant, point at the entry it was clustered under.
    let canonicalOf: SkillDetail["canonicalOf"] = null;
    if (row.canonicalSkillId) {
      const [parent] = await tx
        .select({
          slug: skills.slug,
          name: skills.name,
          similarity: skillDuplicates.similarity,
        })
        .from(skillDuplicates)
        .innerJoin(skills, eq(skills.id, skillDuplicates.canonicalSkillId))
        .where(eq(skillDuplicates.duplicateSkillId, row.id))
        .limit(1);
      canonicalOf = parent ?? null;
    }

    return {
      ...row,
      frontmatter: (row.frontmatter ?? {}) as Record<string, unknown>,
      provenance: (row.provenance ?? {}) as Record<string, unknown>,
      licenseEvidence: (row.licenseEvidence ?? null) as Record<string, unknown> | null,
      verdicts: [...newest.values()].map((verdict) => ({
        analyzer: verdict.analyzer,
        analyzerVersion: verdict.analyzerVersion,
        result: verdict.result,
        severity: verdict.severity,
        findings:
          ((verdict.evidence as Record<string, unknown>)
            ?.findings as SkillDetail["verdicts"][number]["findings"]) ?? [],
        data:
          ((verdict.evidence as Record<string, unknown>)?.data as Record<
            string,
            unknown
          >) ?? {},
      })),
      categories: categoryRows.map((c) => ({ axis: c.axis, value: c.value })),
      capabilities: Object.entries(surface)
        .filter(([, value]) => value?.present)
        .map(([key]) => key),
      undocumented: surfaceRow?.undocumented ?? [],
      surface,
      variants: variantRows,
      canonicalOf,
    } satisfies SkillDetail;
  });
}
