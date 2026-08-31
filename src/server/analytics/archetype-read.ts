import "server-only";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { archetypes } from "@/server/db/schema";
import { withPublicScope } from "@/server/dal/scope";
import { getSkillsByIds, type SkillRef } from "@/server/dal/skills";
import { FUNCTIONS } from "@/server/taxonomy/vocabulary";
import {
  MIN_SOURCES,
  MIN_STRUCTURES,
  type Contributor,
  type SkeletonSection,
  type SkeletonTrait,
} from "./archetype";

/**
 * Reads that render an archetype to a person (R3.3, R3.4).
 *
 * Separate from `archetype-run.ts` on purpose: that module mines and persists, this one
 * only reads, and the two have opposite risk profiles. Mining runs from a terminal with
 * no session; this runs on a public page for anyone.
 *
 * ## Public archetypes only, stated in the query
 *
 * Every read here pins `org_id is null` **and** runs in `withPublicScope`. Either alone
 * would do the job today; both are here because Doc 1's OQ-C2 answers "may org-private
 * archetypes ever feed public ones?" with *never, by default*, and that is the kind of
 * default which should be visible in the code that would violate it rather than only in
 * a policy on a table. When org-scoped archetypes arrive (the Team tier blends private
 * evidence), this module keeps returning the public one and a separate read serves theirs.
 */

export type ArchetypeSkeleton = {
  sections: SkeletonSection[];
  traits: SkeletonTrait[];
  norms: {
    medianWords: number;
    medianDescriptionLength: number;
    medianFileCount: number;
  };
};

const EMPTY_SKELETON: ArchetypeSkeleton = {
  sections: [],
  traits: [],
  norms: { medianWords: 0, medianDescriptionLength: 0, medianFileCount: 0 },
};

/** What the gate asks for, so a category without an archetype can say why. */
export const EVIDENCE_GATE = { structures: MIN_STRUCTURES, sources: MIN_SOURCES } as const;

export type ArchetypeIndexEntry = {
  category: string;
  label: string;
  description: string;
  /** Null when nothing has cleared the evidence gate for this category yet. */
  version: number | null;
  skillCount: number;
  distinctStructures: number;
  sourceCount: number;
  sections: SkeletonSection[];
  traits: SkeletonTrait[];
  antiPatternCount: number;
  minedAt: Date | null;
};

/**
 * One card per function category, mined or not.
 *
 * Categories with no archetype are listed rather than hidden. A registry that quietly drops
 * the twelve categories it has nothing to say about looks complete and teaches an author
 * nothing about where the corpus is thin — and "we do not have enough evidence yet" is a
 * more useful answer than an absent tile, especially while ingestion is a sixth done.
 */
export async function archetypeIndex(): Promise<ArchetypeIndexEntry[]> {
  const rows = await withPublicScope((tx) =>
    tx
      .select({
        category: archetypes.category,
        version: archetypes.version,
        skillCount: archetypes.skillCount,
        distinctStructures: archetypes.distinctStructures,
        sourceCount: archetypes.sourceCount,
        skeleton: archetypes.skeleton,
        antiPatterns: archetypes.antiPatterns,
        createdAt: archetypes.createdAt,
      })
      .from(archetypes)
      .where(and(eq(archetypes.axis, "function"), isNull(archetypes.orgId)))
      .orderBy(archetypes.category, desc(archetypes.version)),
  );

  // Newest version per category. Done in code rather than with DISTINCT ON so the rule
  // stays legible next to the ordering that implements it.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.category)) latest.set(row.category, row);

  return FUNCTIONS.map((fn) => {
    const row = latest.get(fn.id);
    const skeleton = (row?.skeleton as ArchetypeSkeleton | undefined) ?? EMPTY_SKELETON;
    return {
      category: fn.id,
      label: fn.label,
      description: fn.description,
      version: row?.version ?? null,
      skillCount: row?.skillCount ?? 0,
      distinctStructures: row?.distinctStructures ?? 0,
      sourceCount: row?.sourceCount ?? 0,
      sections: skeleton.sections ?? [],
      traits: skeleton.traits ?? [],
      antiPatternCount: ((row?.antiPatterns as SkeletonTrait[] | undefined) ?? []).length,
      minedAt: row?.createdAt ?? null,
    };
  });
}

export type ArchetypeDetail = {
  category: string;
  label: string;
  description: string;
  version: number;
  skeleton: ArchetypeSkeleton;
  antiPatterns: SkeletonTrait[];
  /** R3.4: the sources this skeleton was derived from, best-represented first. */
  contributors: Contributor[];
  /** R3.3: pinned exemplars, resolved against the corpus as it stands now. */
  exemplars: SkillRef[];
  /** Pinned exemplars that no longer resolve — de-listed since the mine. */
  retiredExemplars: number;
  skillCount: number;
  distinctStructures: number;
  sourceCount: number;
  strongThreshold: number | null;
  weakThreshold: number | null;
  extractorVersion: string;
  minerVersion: string;
  taxonomyVersion: string;
  minedAt: Date;
  /** Every version so far, newest first — R3.5's convention drift, in its cheapest form. */
  history: Array<{ version: number; changelog: string | null; minedAt: Date }>;
};

/** The full archetype for a category, or null when none has been mined. */
export async function archetypeDetail(category: string): Promise<ArchetypeDetail | null> {
  const fn = FUNCTIONS.find((f) => f.id === category);
  if (!fn) return null;

  const versions = await withPublicScope((tx) =>
    tx
      .select({
        version: archetypes.version,
        skeleton: archetypes.skeleton,
        stats: archetypes.stats,
        antiPatterns: archetypes.antiPatterns,
        exemplarSkillIds: archetypes.exemplarSkillIds,
        skillCount: archetypes.skillCount,
        distinctStructures: archetypes.distinctStructures,
        sourceCount: archetypes.sourceCount,
        strongThreshold: archetypes.strongThreshold,
        weakThreshold: archetypes.weakThreshold,
        extractorVersion: archetypes.extractorVersion,
        minerVersion: archetypes.minerVersion,
        taxonomyVersion: archetypes.taxonomyVersion,
        changelog: archetypes.changelog,
        createdAt: archetypes.createdAt,
      })
      .from(archetypes)
      .where(
        and(
          eq(archetypes.axis, "function"),
          eq(archetypes.category, category),
          isNull(archetypes.orgId),
        ),
      )
      .orderBy(desc(archetypes.version)),
  );

  const current = versions[0];
  if (!current) return null;

  const exemplarIds = current.exemplarSkillIds ?? [];
  // Public scope, matching this module's contract. An exemplar comes from the public
  // corpus by construction, and resolving it in org scope would both widen the list for a
  // signed-in viewer and require a session where none should be needed.
  const exemplars = await getSkillsByIds(exemplarIds, { publicOnly: true });

  const stats = (current.stats ?? {}) as { contributors?: Contributor[] };

  return {
    category,
    label: fn.label,
    description: fn.description,
    version: current.version,
    skeleton: (current.skeleton as ArchetypeSkeleton | null) ?? EMPTY_SKELETON,
    antiPatterns: (current.antiPatterns as SkeletonTrait[] | null) ?? [],
    // Absent on rows mined before 2.1.0. An empty list renders as "attribution not
    // recorded for this version" rather than as "no sources", which would be a lie.
    contributors: stats.contributors ?? [],
    exemplars,
    retiredExemplars: exemplarIds.length - exemplars.length,
    skillCount: current.skillCount,
    distinctStructures: current.distinctStructures,
    sourceCount: current.sourceCount,
    strongThreshold: current.strongThreshold,
    weakThreshold: current.weakThreshold,
    extractorVersion: current.extractorVersion,
    minerVersion: current.minerVersion,
    taxonomyVersion: current.taxonomyVersion,
    minedAt: current.createdAt,
    history: versions.map((row) => ({
      version: row.version,
      changelog: row.changelog,
      minedAt: row.createdAt,
    })),
  };
}

/** Every mined category slug, for `generateStaticParams`-style needs and cross-links. */
export async function minedCategories(): Promise<Set<string>> {
  const rows = await withPublicScope((tx) =>
    tx
      .selectDistinct({ category: archetypes.category })
      .from(archetypes)
      .where(and(eq(archetypes.axis, "function"), isNull(archetypes.orgId)))
      .orderBy(asc(archetypes.category)),
  );
  return new Set(rows.map((row) => row.category));
}
