import "server-only";
import { ingestPolicy } from "@/server/crawl/policy";
import { mapWithConcurrency } from "@/server/lib/concurrency";

import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { events, skills, skillStructures, skillVersions } from "@/server/db/schema";
import { splitFrontmatter } from "@/server/skills/normalize";
import { loadBundle, type VersionProvenance } from "@/server/validation/bundle-loader";

import { EXTRACTOR_VERSION, extractStructure } from "./structure";

/**
 * The extraction pass that fills `skill_structures`.
 *
 * Mirrors `validation/run.ts` on purpose — same bundle loader, same marker detection, same
 * bounded-slice shape — because it has the same constraint: a serverless invocation is
 * capped, and the corpus is bigger than one run. So this does a slice, reports it, and is
 * safe to call again.
 *
 * Unlike validation this is **not** a trust boundary. A bundle that fails to load is
 * counted and skipped, not quarantined: a missing fingerprint means one skill sits out of
 * archetype mining, which is a coverage problem, not a safety one. Failing closed here
 * would mean a transient R2 error could quarantine a skill that already passed validation.
 */

export type ExtractOptions = {
  /** Only these version ids. Default: everything without a current-version fingerprint. */
  versionIds?: string[];
  /** Re-extract versions that already have one at this extractor version. */
  force?: boolean;
  limit?: number;
  onProgress?: (message: string) => void;
};

export type ExtractReport = {
  extracted: number;
  failed: number;
  /** Distinct heading strings no rule recognised — the LLM pass's whole input. */
  unresolvedHeadings: string[];
  remaining: number;
};

export async function extractStructures(
  options: ExtractOptions = {},
): Promise<ExtractReport> {
  const log = options.onProgress ?? (() => {});
  const limit = options.limit ?? 500;

  // Only versions that are actually part of the corpus. A tombstoned version has no
  // content to measure, and a pending one has not been judged yet — mining reads verdicts
  // alongside these rows, so extracting before validation would produce rows that cannot
  // be banded by quality.
  const eligible = inArray(skillVersions.status, ["indexed", "quarantined"]);

  const missing = notExists(
    db
      .select({ one: sql`1` })
      .from(skillStructures)
      .where(
        and(
          eq(skillStructures.skillVersionId, skillVersions.id),
          eq(skillStructures.extractorVersion, EXTRACTOR_VERSION),
        ),
      ),
  );

  const where = options.versionIds?.length
    ? inArray(skillVersions.id, options.versionIds)
    : options.force
      ? eligible
      : and(eligible, missing);

  const rows = await db
    .select({
      id: skillVersions.id,
      orgId: skillVersions.orgId,
      skillId: skillVersions.skillId,
      slug: skills.slug,
      contentHash: skillVersions.contentHash,
      contentStored: skillVersions.contentStored,
      provenance: skillVersions.provenance,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .where(where)
    .limit(limit);

  const report: ExtractReport = {
    extracted: 0,
    failed: 0,
    unresolvedHeadings: [],
    remaining: 0,
  };
  const unresolved = new Set<string>();

  /**
   * Concurrent, because the cost here is the bundle read, not the parsing.
   *
   * Each row writes only its own `skill_structures` row, keyed by
   * `(skill_version_id, extractor_version)`, so nothing is shared between lanes. `report`
   * and `unresolved` are mutated from several lanes, which is safe on a single-threaded
   * event loop: every increment happens between awaits, never across one.
   */
  await mapWithConcurrency(rows, ingestPolicy.bundleConcurrency, async (row) => {
    try {
      const provenance = row.provenance as VersionProvenance;
      const { files } = await loadBundle({
        contentStored: row.contentStored,
        contentHash: row.contentHash,
        tier: "public",
        provenance,
      });

      const marker = files.find((f) => /^(SKILL|AGENTS)\.md$/i.test(f.path)) ?? files[0];
      if (!marker) {
        report.failed += 1;
        // `return`, not `continue`: this is a worker callback now, not a loop body.
        return;
      }

      const { frontmatter, body } = splitFrontmatter(marker.content.toString("utf8"));
      const fingerprint = extractStructure({
        files,
        body,
        frontmatter,
        markerPath: marker.path,
      });

      for (const heading of fingerprint.unresolvedHeadings) unresolved.add(heading);

      await db.transaction(async (tx) => {
        if (row.orgId) {
          await tx.execute(sql`select set_config('app.org_id', ${row.orgId}, true)`);
        }
        await tx
          .insert(skillStructures)
          .values({
            orgId: row.orgId,
            skillId: row.skillId,
            skillVersionId: row.id,
            extractorVersion: fingerprint.extractorVersion,
            headings: fingerprint.headings,
            sectionRoles: fingerprint.sectionRoles,
            headingCount: fingerprint.headingCount,
            maxHeadingDepth: fingerprint.maxHeadingDepth,
            bodyBytes: fingerprint.bodyBytes,
            wordCount: fingerprint.wordCount,
            codeBlockCount: fingerprint.codeBlockCount,
            codeLanguages: fingerprint.codeLanguages,
            listItemCount: fingerprint.listItemCount,
            tableCount: fingerprint.tableCount,
            proseRatio: fingerprint.proseRatio,
            linkCount: fingerprint.linkCount,
            internalLinkCount: fingerprint.internalLinkCount,
            brokenLinkCount: fingerprint.brokenLinkCount,
            fileCount: fingerprint.fileCount,
            hasScripts: fingerprint.hasScripts,
            hasReferences: fingerprint.hasReferences,
            hasAssets: fingerprint.hasAssets,
            hasTemplates: fingerprint.hasTemplates,
            resourceDirs: fingerprint.resourceDirs,
            fileExtensions: fingerprint.fileExtensions,
            frontmatterKeys: fingerprint.frontmatterKeys,
            descriptionLength: fingerprint.descriptionLength,
            descriptionShape: fingerprint.descriptionShape,
          })
          // Supersede by upsert: a fingerprint is derived, so an old one carries no
          // history worth keeping — unlike a verdict, which is a judgement.
          .onConflictDoUpdate({
            target: [skillStructures.skillVersionId, skillStructures.extractorVersion],
            set: {
              headings: fingerprint.headings,
              sectionRoles: fingerprint.sectionRoles,
              headingCount: fingerprint.headingCount,
              maxHeadingDepth: fingerprint.maxHeadingDepth,
              bodyBytes: fingerprint.bodyBytes,
              wordCount: fingerprint.wordCount,
              codeBlockCount: fingerprint.codeBlockCount,
              codeLanguages: fingerprint.codeLanguages,
              listItemCount: fingerprint.listItemCount,
              tableCount: fingerprint.tableCount,
              proseRatio: fingerprint.proseRatio,
              linkCount: fingerprint.linkCount,
              internalLinkCount: fingerprint.internalLinkCount,
              brokenLinkCount: fingerprint.brokenLinkCount,
              fileCount: fingerprint.fileCount,
              hasScripts: fingerprint.hasScripts,
              hasReferences: fingerprint.hasReferences,
              hasAssets: fingerprint.hasAssets,
              hasTemplates: fingerprint.hasTemplates,
              resourceDirs: fingerprint.resourceDirs,
              fileExtensions: fingerprint.fileExtensions,
              frontmatterKeys: fingerprint.frontmatterKeys,
              descriptionLength: fingerprint.descriptionLength,
              descriptionShape: fingerprint.descriptionShape,
              createdAt: new Date(),
            },
          });
      });

      report.extracted += 1;
      if (report.extracted % 100 === 0) log(`fingerprinted ${report.extracted}`);
    } catch {
      // Counted, not thrown: one unreadable bundle must not end the slice — and caught
      // inside the worker so a single failure cannot reject the whole batch.
      report.failed += 1;
    }
  });

  report.unresolvedHeadings = [...unresolved].sort();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(and(eligible, missing));
  report.remaining = count;

  if (report.extracted > 0) {
    await db.insert(events).values({
      actorType: "system",
      actorId: "analytics.structure",
      kind: "structures.extracted",
      subjectType: "skill_structures",
      reason: `extractor ${EXTRACTOR_VERSION}`,
      payload: {
        extracted: report.extracted,
        failed: report.failed,
        remaining: report.remaining,
        unresolvedHeadings: report.unresolvedHeadings.length,
      },
    });
  }

  return report;
}

/** Coverage and the headline shape stats, for the settings panel. */
export async function structureSummary() {
  const [totals] = await db
    .select({
      fingerprinted: sql<number>`count(*)::int`,
      withScripts: sql<number>`count(*) filter (where ${skillStructures.hasScripts})::int`,
      withReferences: sql<number>`count(*) filter (where ${skillStructures.hasReferences})::int`,
      multiFile: sql<number>`count(*) filter (where ${skillStructures.fileCount} > 1)::int`,
      avgHeadings: sql<number>`coalesce(round(avg(${skillStructures.headingCount}))::int, 0)`,
      avgWords: sql<number>`coalesce(round(avg(${skillStructures.wordCount}))::int, 0)`,
    })
    .from(skillStructures)
    .where(eq(skillStructures.extractorVersion, EXTRACTOR_VERSION));

  const roles = await db
    .select({
      role: sql<string>`role`,
      count: sql<number>`count(*)::int`,
    })
    .from(
      sql`(select unnest(${skillStructures.sectionRoles}) as role
           from ${skillStructures}
           where ${skillStructures.extractorVersion} = ${EXTRACTOR_VERSION}) roles`,
    )
    .groupBy(sql`role`)
    .orderBy(sql`count(*) desc`);

  const [{ eligible }] = await db
    .select({ eligible: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(inArray(skillVersions.status, ["indexed", "quarantined"]));

  return { totals, roles, eligible };
}
