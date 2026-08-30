import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { events, skills, skillVersions } from "@/server/db/schema";

import { ANALYZER_VERSIONS, validatePending } from "./run";

/**
 * Re-scan campaigns (Doc 2 R2.12).
 *
 * ## The need is measured, not anticipated
 *
 * `structural-lint` went 1.0.0 → 1.3.0 in one session, three times because a rule was
 * wrong: it judged AGENTS.md against SKILL.md's frontmatter contract, it reported malformed
 * YAML as a missing field, and it blocked skills whose identity was derivable. Each fix was
 * followed by a throwaway script that re-validated whichever slice seemed affected.
 *
 * That approach leaves a residue, and the residue is visible in the table: **4,090 verdicts
 * still sit at `structural-lint@1.0.0`** — everything that *passed* under the old rules and
 * so was never in any of the slices I thought to re-check. Their status is fine (the fixes
 * only loosened rules, so nothing is wrongly indexed) but their **quality scores are stale**,
 * computed from findings that no longer exist. Quality score is what ranks the registry.
 *
 * So the selector is not "skills that look affected". It is **every version whose newest
 * verdict from an analyzer predates that analyzer's current version** — which needs no
 * judgement about what a rule change touched, and cannot miss the cases nobody thought of.
 *
 * ## Comparison is on the version, not a timestamp
 *
 * A verdict's age says nothing: an analyzer can go a month without changing. `analyzer_version`
 * is the contract R2.12 is written against and the field the verdict already stores.
 */

/** Numeric semver compare. Non-numeric segments sort as 0 rather than throwing. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type StaleSlice = {
  analyzer: string;
  /** The version currently shipping. */
  currentVersion: string;
  /** Distinct versions found below it, with counts. */
  behind: Array<{ version: string; count: number }>;
  total: number;
};

/**
 * What is out of date, per analyzer.
 *
 * Read-only and cheap — the number to put in front of a curator so a stale corpus is a
 * visible fact rather than something discovered later. The 7-day SLA in R2.12 only means
 * anything if somebody can see the clock.
 */
export async function staleSlices(): Promise<StaleSlice[]> {
  const rows = await db.execute(sql`
    with newest as (
      select distinct on (skill_version_id, analyzer)
             skill_version_id, analyzer, analyzer_version
      from verdicts
      order by skill_version_id, analyzer, created_at desc
    )
    select analyzer, analyzer_version, count(*)::int as count
    from newest
    group by analyzer, analyzer_version
  `);

  const byAnalyzer = new Map<string, Array<{ version: string; count: number }>>();
  for (const row of rows.rows as Array<{
    analyzer: string;
    analyzer_version: string;
    count: number;
  }>) {
    const list = byAnalyzer.get(row.analyzer) ?? [];
    list.push({ version: row.analyzer_version, count: row.count });
    byAnalyzer.set(row.analyzer, list);
  }

  const slices: StaleSlice[] = [];
  for (const [analyzer, versions] of byAnalyzer) {
    const currentVersion = ANALYZER_VERSIONS[analyzer];
    // An analyzer that no longer ships leaves verdicts behind. They are history, not a
    // backlog — there is nothing to re-run them with.
    if (!currentVersion) continue;

    const behind = versions
      .filter((v) => compareVersions(v.version, currentVersion) < 0)
      .sort((a, b) => compareVersions(a.version, b.version));

    slices.push({
      analyzer,
      currentVersion,
      behind,
      total: behind.reduce((sum, v) => sum + v.count, 0),
    });
  }

  return slices.sort((a, b) => b.total - a.total);
}

export type RescanReport = {
  analyzer: string | null;
  selected: number;
  rejudged: number;
  statusChanged: number;
  scoreChanged: number;
  remaining: number;
};

/**
 * Re-judges versions whose verdicts predate the current analyzer versions.
 *
 * Bounded like every other pass. Deliberately re-runs **all** analyzers on a selected
 * version rather than only the stale one: they share a single quality score, and re-running
 * one in isolation would recompute that score from a mix of fresh and stale findings — a
 * number that is wrong in a new way rather than an old one.
 *
 * The costly LLM analyzers stay out. A rule change to `structural-lint` is no reason to pay
 * for a fresh R2.3 audit of the same skill, and `includeCostly` is not exposed here for
 * exactly that reason.
 */
export async function runRescan(
  options: { analyzer?: string; limit?: number; onProgress?: (m: string) => void } = {},
): Promise<RescanReport> {
  const log = options.onProgress ?? (() => {});
  const limit = Math.min(Math.max(1, options.limit ?? 200), 1000);

  const slices = await staleSlices();
  const targets = options.analyzer
    ? slices.filter((s) => s.analyzer === options.analyzer)
    : slices;

  if (targets.length === 0 || targets.every((s) => s.total === 0)) {
    return {
      analyzer: options.analyzer ?? null,
      selected: 0,
      rejudged: 0,
      statusChanged: 0,
      scoreChanged: 0,
      remaining: 0,
    };
  }

  // One query per analyzer, then a single de-duplicated id set: a version can be stale on
  // two analyzers at once and must not be judged twice in the same pass.
  const ids = new Set<string>();
  for (const slice of targets) {
    if (slice.total === 0) continue;
    const rows = await db.execute(sql`
      with newest as (
        select distinct on (skill_version_id)
               skill_version_id, analyzer_version
        from verdicts
        where analyzer = ${slice.analyzer}
        order by skill_version_id, created_at desc
      )
      select n.skill_version_id as id
      from newest n
      join skill_versions sv on sv.id = n.skill_version_id
      where sv.status in ('indexed', 'quarantined')
        and string_to_array(n.analyzer_version, '.')::int[]
            < string_to_array(${slice.currentVersion}, '.')::int[]
      limit ${limit}
    `);
    for (const row of rows.rows as Array<{ id: string }>) ids.add(row.id);
    if (ids.size >= limit) break;
  }

  const selected = [...ids].slice(0, limit);
  if (selected.length === 0) {
    return {
      analyzer: options.analyzer ?? null,
      selected: 0,
      rejudged: 0,
      statusChanged: 0,
      scoreChanged: 0,
      remaining: 0,
    };
  }

  // Statuses and scores before, so the campaign can report what actually moved rather than
  // just how many rows it touched. Through the query builder, not interpolated SQL: these
  // ids come from our own tables, but building statements by string concatenation is a
  // habit that outlives the context that made it safe.
  const beforeRows = await db
    .select({
      id: skillVersions.id,
      status: skillVersions.status,
      qualityScore: skills.qualityScore,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .where(inArray(skillVersions.id, selected));

  const before = new Map(beforeRows.map((row) => [row.id, row]));

  log(`re-judging ${selected.length} version(s)`);
  const outcomes = await validatePending({ versionIds: selected, revalidate: true });

  let statusChanged = 0;
  let scoreChanged = 0;
  for (const outcome of outcomes) {
    const prior = before.get(outcome.skillVersionId);
    if (!prior) continue;
    if (prior.status !== outcome.status) statusChanged += 1;
    if (prior.qualityScore !== outcome.qualityScore) scoreChanged += 1;
  }

  const after = await staleSlices();
  const remaining = after
    .filter((s) => !options.analyzer || s.analyzer === options.analyzer)
    .reduce((sum, s) => sum + s.total, 0);

  await db.insert(events).values({
    actorType: "system",
    actorId: "validation.rescan",
    kind: "verdicts.rescanned",
    subjectType: "verdicts",
    reason: options.analyzer
      ? `campaign for ${options.analyzer}`
      : "campaign across all stale analyzers",
    payload: {
      analyzer: options.analyzer ?? null,
      selected: selected.length,
      rejudged: outcomes.length,
      statusChanged,
      scoreChanged,
      remaining,
    },
  });

  return {
    analyzer: options.analyzer ?? null,
    selected: selected.length,
    rejudged: outcomes.length,
    statusChanged,
    scoreChanged,
    remaining,
  };
}
