import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  capabilitySurfaces,
  events,
  skills,
  skillVersions,
  verdicts,
} from "@/server/db/schema";
import { splitFrontmatter } from "@/server/skills/normalize";

import { capabilitySurface } from "./analyzers/capability-surface";
import { injectionScan } from "./analyzers/injection-scan";
import { secretScan } from "./analyzers/secret-scan";
import { structuralLint } from "./analyzers/structural-lint";
import { loadBundle, type VersionProvenance } from "./bundle-loader";
import { blocks, worstSeverity, type Analyzer, type AnalyzerOutput } from "./types";

/**
 * The validation pass — the trust boundary (Doc 2 §7.2).
 *
 * Rules only at this stage: structure, secrets, injection, capability surface. LLM
 * analyzers (R2.3) come later and cost money; these cost nothing and catch the things
 * that are unambiguous.
 *
 * Fail closed, in three ways that matter:
 *   - a `fail` or an analyzer crash quarantines; nothing is promoted by default
 *   - quarantine keeps machine-readable reasons, so a decision is explainable and
 *     appealable — a skill is never silently dropped
 *   - verdicts are append-only and versioned, so improving a rule means re-running it,
 *     not editing history
 */

const ANALYZERS: Analyzer[] = [structuralLint, secretScan, injectionScan, capabilitySurface];

export type ValidationOutcome = {
  skillVersionId: string;
  slug: string;
  status: "indexed" | "quarantined";
  reasons: string[];
  qualityScore: number;
  origin: "storage" | "refetch";
  perAnalyzer: Array<{ analyzer: string; result: string; findings: number }>;
};

export type ValidateOptions = {
  /** Only these version ids. Default: everything still awaiting a verdict. */
  versionIds?: string[];
  /** Re-judge versions that already have verdicts (a re-scan campaign). */
  revalidate?: boolean;
  limit?: number;
  onProgress?: (message: string) => void;
};

export async function validatePending(
  options: ValidateOptions = {},
): Promise<ValidationOutcome[]> {
  const log = options.onProgress ?? (() => {});

  const statuses = options.revalidate
    ? (["pending", "validating", "indexed", "quarantined", "revalidating"] as const)
    : (["pending", "validating", "revalidating"] as const);

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
    .where(
      options.versionIds?.length
        ? inArray(skillVersions.id, options.versionIds)
        : inArray(skillVersions.status, [...statuses]),
    )
    .limit(options.limit ?? 1000);

  const outcomes: ValidationOutcome[] = [];

  for (const row of rows) {
    log(`validating ${row.slug}`);
    outcomes.push(await validateOne(row));
  }

  return outcomes;
}

type VersionRow = {
  id: string;
  orgId: string | null;
  skillId: string;
  slug: string;
  contentHash: string;
  contentStored: boolean;
  provenance: unknown;
};

async function validateOne(row: VersionRow): Promise<ValidationOutcome> {
  const provenance = row.provenance as VersionProvenance;

  const { files, origin } = await loadBundle({
    contentStored: row.contentStored,
    contentHash: row.contentHash,
    tier: "public",
    provenance,
  });

  const marker =
    files.find((file) => /^(SKILL|AGENTS)\.md$/i.test(file.path)) ?? files[0];
  const { frontmatter, body } = splitFrontmatter(marker.content.toString("utf8"));
  const input = { files, body, frontmatter, markerPath: marker.path };

  const results: Array<{ analyzer: Analyzer; output: AnalyzerOutput }> = [];
  for (const analyzer of ANALYZERS) {
    try {
      results.push({ analyzer, output: analyzer.run(input) });
    } catch (error) {
      // A crashed analyzer has not cleared the skill. Treating it as a pass is exactly
      // how a validation pipeline quietly stops being one.
      results.push({
        analyzer,
        output: {
          result: "error",
          findings: [
            {
              reason: "analyzer-error",
              severity: "high",
              message: `${analyzer.name} threw: ${(error as Error).message}`,
            },
          ],
        },
      });
    }
  }

  const blocking = results.filter(({ output }) => blocks(output.result));
  const status: "indexed" | "quarantined" = blocking.length > 0 ? "quarantined" : "indexed";
  const reasons = [
    ...new Set(blocking.flatMap(({ output }) => output.findings.map((f) => f.reason))),
  ];
  const qualityScore = scoreOf(results);

  await db.transaction(async (tx) => {
    if (row.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${row.orgId}, true)`);
    }

    for (const { analyzer, output } of results) {
      await tx.insert(verdicts).values({
        orgId: row.orgId,
        skillVersionId: row.id,
        analyzer: analyzer.name,
        analyzerVersion: analyzer.version,
        result: output.result,
        severity: worstSeverity(output.findings),
        reason: output.findings[0]?.reason ?? null,
        evidence: {
          findings: output.findings,
          data: output.data ?? {},
          bundleOrigin: origin,
          contentHash: row.contentHash,
        },
      });
    }

    const surfaceOutput = results.find(
      ({ analyzer }) => analyzer.name === capabilitySurface.name,
    );
    if (surfaceOutput?.output.data) {
      await tx
        .insert(capabilitySurfaces)
        .values({
          orgId: row.orgId,
          skillVersionId: row.id,
          analyzer: capabilitySurface.name,
          analyzerVersion: capabilitySurface.version,
          surface: surfaceOutput.output.data.surface as Record<string, unknown>,
          undocumented: (surfaceOutput.output.data.undocumented as string[]) ?? [],
        })
        .onConflictDoNothing();
    }

    await tx
      .update(skillVersions)
      .set({ status, quarantineReasons: reasons.length > 0 ? reasons : null })
      .where(eq(skillVersions.id, row.id));

    await tx
      .update(skills)
      .set({
        status,
        qualityScore,
        // Only a passing version is ever served.
        currentVersionId: status === "indexed" ? row.id : null,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, row.skillId));

    await tx.insert(events).values({
      orgId: row.orgId,
      actorType: "analyzer",
      actorId: "validation",
      kind: `skill_version.${status}`,
      subjectType: "skill_versions",
      subjectId: row.id,
      reason: reasons.join(", ") || null,
      payload: {
        analyzers: results.map(({ analyzer, output }) => ({
          name: analyzer.name,
          version: analyzer.version,
          result: output.result,
          findings: output.findings.length,
        })),
        qualityScore,
        bundleOrigin: origin,
      },
    });
  });

  return {
    skillVersionId: row.id,
    slug: row.slug,
    status,
    reasons,
    qualityScore,
    origin,
    perAnalyzer: results.map(({ analyzer, output }) => ({
      analyzer: analyzer.name,
      result: output.result,
      findings: output.findings.length,
    })),
  };
}

/**
 * A first, honest quality score (Doc 2 R2.9): start at 100 and subtract for what the
 * rules found. Crude, but public and explainable, which matters more right now than
 * precision — and popularity is deliberately not an input.
 */
function scoreOf(results: Array<{ analyzer: Analyzer; output: AnalyzerOutput }>): number {
  const weights: Record<string, number> = {
    info: 1,
    low: 3,
    medium: 8,
    high: 20,
    critical: 40,
  };
  const penalty = results
    .flatMap(({ output }) => output.findings)
    .reduce((total, finding) => total + (weights[finding.severity] ?? 0), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

/** Re-scan selector: every version last judged by an older version of an analyzer. */
export async function versionsNeedingRescan(analyzer: string, version: string) {
  return db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .innerJoin(verdicts, eq(verdicts.skillVersionId, skillVersions.id))
    .where(and(eq(verdicts.analyzer, analyzer), sql`${verdicts.analyzerVersion} <> ${version}`))
    .groupBy(skillVersions.id);
}
