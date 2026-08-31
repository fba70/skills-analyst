import "server-only";

import { SEVERITY_WEIGHTS, substanceFactor } from "@/lib/quality";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { withExplicitOrgScope } from "@/server/dal/scope";
import {
  capabilitySurfaces,
  events,
  skills,
  skillVersions,
  verdicts,
} from "@/server/db/schema";
import { splitFrontmatter } from "@/server/skills/normalize";

import { capabilitySurface } from "./analyzers/capability-surface";
import { consistencyCheck, hasAuditableCode } from "./analyzers/consistency";
import { injectionScan } from "./analyzers/injection-scan";
import { secretScan } from "./analyzers/secret-scan";
import { structuralLint } from "./analyzers/structural-lint";
import { loadBundle, type VersionProvenance } from "./bundle-loader";
import {
  blocks,
  worstSeverity,
  type Analyzer,
  type AnalyzerInput,
  type AnalyzerOutput,
} from "./types";

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

/**
 * Free, deterministic, always run.
 */
const ANALYZERS: Analyzer[] = [structuralLint, secretScan, injectionScan, capabilitySurface];

/**
 * Costly, opt-in. R2.3 needs a model per skill, so it is never part of the default pass —
 * a validate run has to stay something you can trigger without thinking about the bill.
 */
const COSTLY_ANALYZERS: Analyzer[] = [consistencyCheck];

/**
 * The version each analyzer currently ships, by name.
 *
 * Derived from the analyzer objects rather than written out, so it cannot drift from what
 * actually runs — a hand-maintained copy would be wrong the first time someone bumped a
 * version and forgot this list, and the whole point of R2.12 is trusting these numbers.
 */
export const ANALYZER_VERSIONS: Record<string, string> = Object.fromEntries(
  [...ANALYZERS, ...COSTLY_ANALYZERS].map((analyzer) => [analyzer.name, analyzer.version]),
);

/**
 * Version ids whose bundle carries executable code, per the structural fingerprint.
 *
 * The targeting query for an R2.3 campaign. Running the consistency check across the whole
 * corpus would pay for ~3,000 model calls to learn that ~93% of skills have no code to be
 * inconsistent with; this asks the fingerprints which ones are worth the call. `hasScripts`
 * is the fingerprint's own flag, so no bundle is re-read to answer it.
 *
 * Ordered by file count descending: the bundles with the most code are the ones where a
 * documentation gap is most likely and most consequential.
 */
export async function versionsWithCode(limit = 25): Promise<string[]> {
  const rows = await db.execute(sql`
    select st.skill_version_id as id
    from skill_structures st
    join skill_versions sv on sv.id = st.skill_version_id
    where st.has_scripts
      and sv.status in ('indexed', 'quarantined')
      and not exists (
        select 1 from verdicts v
        where v.skill_version_id = sv.id
          and v.analyzer = 'description-consistency'
      )
    order by st.file_count desc
    limit ${limit}
  `);
  return (rows.rows as Array<{ id: string }>).map((row) => row.id);
}

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
  /**
   * Include the LLM-assisted analyzers (R2.3). **Costs money per skill with bundled code.**
   *
   * Off by default and named for what it does rather than a vague `full` flag, because the
   * caller should have to say the expensive thing out loud.
   */
  includeCostly?: boolean;
  limit?: number;
  /**
   * Validate an organisation's own content (R6.1).
   *
   * Without this the selection below runs unscoped, and RLS answers with `org_id IS NULL`
   * only — so an org-scoped version is **invisible to the validator**. A published draft
   * would be created, handed to this function, and silently not validated, leaving the
   * skill stuck at `pending` for ever.
   *
   * The write path was already correct: `validateOne` sets `app.org_id` from the row it is
   * judging. Only the read was missing, which is the failure mode that hides best.
   */
  orgId?: string | null;
  onProgress?: (message: string) => void;
};

export async function validatePending(
  options: ValidateOptions = {},
): Promise<ValidationOutcome[]> {
  const log = options.onProgress ?? (() => {});

  const statuses = options.revalidate
    ? (["pending", "validating", "indexed", "quarantined", "revalidating"] as const)
    : (["pending", "validating", "revalidating"] as const);

  const select = (client: typeof db) =>
    client
      .select({
        id: skillVersions.id,
        orgId: skillVersions.orgId,
        skillId: skillVersions.skillId,
        slug: skills.slug,
        dialect: skills.dialect,
        name: skills.name,
        summary: skills.summary,
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

  const rows = options.orgId
    ? await withExplicitOrgScope(options.orgId, (tx) => select(tx))
    : await select(db);

  const outcomes: ValidationOutcome[] = [];

  for (const row of rows) {
    log(`validating ${row.slug}`);
    outcomes.push(await validateOne(row, options.includeCostly ?? false));
  }

  return outcomes;
}

type VersionRow = {
  id: string;
  orgId: string | null;
  skillId: string;
  slug: string;
  dialect: string;
  name: string;
  summary: string | null;
  contentHash: string;
  contentStored: boolean;
  provenance: unknown;
};

async function validateOne(
  row: VersionRow,
  includeCostly: boolean,
): Promise<ValidationOutcome> {
  const provenance = row.provenance as VersionProvenance;

  const { files, origin } = await loadBundle({
    contentStored: row.contentStored,
    contentHash: row.contentHash,
    tier: "public",
    provenance,
  });

  const marker =
    files.find((file) => /^(SKILL|AGENTS)\.md$/i.test(file.path)) ?? files[0];
  const { frontmatter, body, error: parseError } = splitFrontmatter(
    marker.content.toString("utf8"),
  );
  const input = {
    files,
    body,
    frontmatter,
    markerPath: marker.path,
    dialect: row.dialect,
    // Identity as the normalizer resolved it at ingest — frontmatter, then the leading
    // heading, then the directory name. An analyzer asking "does this have a name" should
    // get the answer for the dialect in front of it, not for one specific dialect's YAML.
    resolvedName: row.name || null,
    resolvedSummary: row.summary,
    // "no frontmatter block" is not an error for a dialect that has none, so the analyzer
    // decides what it means rather than the parser.
    parseError,
    // Which budget a costed analyzer bills to (RC.2). Null for the public corpus.
    orgId: row.orgId,
  };

  // The costly pass is skipped entirely for a bundle with no executable content: there is
  // nothing for a consistency check to compare against, so it would be a paid call with a
  // foregone answer.
  const analyzers = [
    ...ANALYZERS,
    ...(includeCostly && hasAuditableCode(files) ? COSTLY_ANALYZERS : []),
  ];

  const results: Array<{ analyzer: Analyzer; output: AnalyzerOutput }> = [];
  for (const analyzer of analyzers) {
    try {
      results.push({ analyzer, output: await analyzer.run(input) });
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

    /**
     * Which version the registry serves after this verdict (R1.5).
     *
     * A pass serves the new version. A failure must **not** blank the pointer: the skill
     * may already have an indexed version that passed, and R1.5 is explicit that the prior
     * version stays served until a new one passes. Setting `null` here meant one bad
     * upstream push withdrew a good skill from the registry entirely — the upstream author
     * could break our listing without touching anything that had ever been validated.
     *
     * So on failure we fall back to the newest still-indexed version of the same skill,
     * and only null out when there genuinely is none.
     */
    let servedVersionId: string | null = row.id;
    let servedStatus: "indexed" | "quarantined" = status;

    if (status !== "indexed") {
      const [fallback] = await tx
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, row.skillId),
            eq(skillVersions.status, "indexed"),
            ne(skillVersions.id, row.id),
          ),
        )
        .orderBy(desc(skillVersions.syncedAt))
        .limit(1);

      servedVersionId = fallback?.id ?? null;
      // The skill stays listed while a good version backs it; the failing version is
      // quarantined on its own row either way, so nothing unvalidated is served.
      servedStatus = fallback ? "indexed" : "quarantined";
    }

    await tx
      .update(skills)
      .set({
        status: servedStatus,
        qualityScore,
        currentVersionId: servedVersionId,
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
/**
 * Quality score (Doc 2 R2.9) — a composite, not an inverted defect count.
 *
 * ## What was wrong
 *
 * This used to be `100 - penalties`, which scores the *absence of problems* and calls it
 * quality. A document with almost nothing in it has almost nothing to penalise, so the
 * registry's default ranking put an **8-word skill and a 4-word skill at the very top**,
 * both on a perfect 100. Meanwhile 87% of the corpus sat at 99 or 100, which is not a
 * ranking signal at all — it is a near-constant.
 *
 * It also broke archetype mining outright. R3.2 contrasts a strong band against a weak one,
 * and with scores compressed into two values the bands came out as "100 versus 99" —
 * comparing perfect skills to almost-perfect ones. Worse, because findings accumulate with
 * surface area (a 12-file skill has twelve chances at an orphaned-resource finding), the
 * "strong" band filled with trivially simple documents and the miner concluded that good
 * review skills are single-file with no code examples. That is an artifact of the metric,
 * stated as guidance.
 *
 * ## What it is now
 *
 * R2.9 asks for structure, **documentation completeness**, and resource hygiene. The
 * penalty term covers structure and hygiene; `substance` supplies the missing half.
 *
 * A skill earns full substance credit at roughly 330 words — enough for a purpose, a
 * trigger and a procedure. Below that it is scaled down, because a document that short
 * cannot be a complete skill however clean it is. The 0.45 floor means a defect-free stub
 * still scores respectably: it is thin, not broken, and the distinction matters when the
 * number is used for ranking rather than gating.
 */
function scoreOf(results: Array<{ analyzer: Analyzer; output: AnalyzerOutput }>): number {
  const penalty = results
    .flatMap(({ output }) => output.findings)
    .reduce(
      (total, finding) =>
        total + (SEVERITY_WEIGHTS[finding.severity as keyof typeof SEVERITY_WEIGHTS] ?? 0),
      0,
    );
  const defectScore = Math.max(0, Math.min(100, 100 - penalty));

  /**
   * How much document there is to judge, from structural-lint's own measurement.
   *
   * Falls back to full credit when the analyzer did not report — a missing measurement
   * must not silently mark every skill down, which would be the same class of error in the
   * other direction.
   */
  const lintData = results.find(({ analyzer }) => analyzer.name === structuralLint.name)?.output
    .data as { bodyBytes?: number } | undefined;
  const bodyBytes = typeof lintData?.bodyBytes === "number" ? lintData.bodyBytes : null;

  if (bodyBytes === null) return defectScore;

  // The constants live in `lib/quality.ts` so the public reference page explains exactly
  // the arithmetic that runs here, rather than a copy of it that can drift.
  return Math.max(0, Math.min(100, Math.round(defectScore * substanceFactor(bodyBytes))));
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


/**
 * Runs the free analyzers over a bundle that exists only in memory.
 *
 * The seam the builder validates a draft through (R4.5). Everything above this point reads
 * a stored version by id and writes verdicts; a draft has neither an id in `skill_versions`
 * nor bytes in R2, and inventing both to reuse `validateOne` would mean persisting an
 * unvalidated skill in order to validate it.
 *
 * The analyzers themselves are untouched — `AnalyzerInput` already takes files rather than
 * a storage key, which is what makes this possible at all. Same set, same order, same
 * crash-is-not-a-pass handling, so a builder draft is held to exactly the standard the
 * registry applies. The costly R2.3 pass is excluded: it compares documentation against
 * bundled code, and a text-only first draft has none.
 */
export async function runAnalyzersOnBundle(
  input: AnalyzerInput,
): Promise<Array<{ analyzer: string; reason: string; severity: string; message: string }>> {
  const collected: Array<{
    analyzer: string;
    reason: string;
    severity: string;
    message: string;
  }> = [];

  for (const analyzer of ANALYZERS) {
    try {
      const output = await analyzer.run(input);
      for (const finding of output.findings) {
        collected.push({
          analyzer: analyzer.name,
          reason: finding.reason,
          severity: finding.severity,
          message: finding.message,
        });
      }
    } catch (error) {
      // A crashed analyzer has not cleared the draft, exactly as it has not cleared a
      // synced skill.
      collected.push({
        analyzer: analyzer.name,
        reason: "analyzer-error",
        severity: "high",
        message: `${analyzer.name} threw: ${(error as Error).message}`,
      });
    }
  }

  return collected;
}
