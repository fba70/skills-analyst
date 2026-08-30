import "server-only";

import { and, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";

import {
  buildSignatures,
  clusterDuplicates,
  pendingSignatureCount,
} from "@/server/analytics/dedupe";
import { db } from "@/server/db";
import { events, skillStructures, skillVersions, sources } from "@/server/db/schema";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { extractStructures } from "@/server/analytics/structure-run";
import { pendingSources, syncSource } from "@/server/ingest/sync";
import { validatePending } from "@/server/validation/run";

/**
 * The ingest pipeline as one operation.
 *
 * ## Why this exists
 *
 * The stages were already correct individually and were only ever run individually — sync
 * here, validate there, fingerprints and signatures whenever someone remembered. What that
 * produced was drift: with the corpus growing by ~180 skills a pass, fingerprints fell
 * **1,566 behind** and dedup signatures **2,240 behind**, and both gaps widened with every
 * sync. Nothing was broken; nothing was keeping up either.
 *
 * That matters beyond tidiness. Archetype mining (R3.2) reads fingerprints, so a skill
 * without one is invisible to it. Dedup decides which skill is canonical, and only
 * canonical skills get classified — so a missing signature quietly keeps a skill out of the
 * taxonomy too. Both failures are silent and look exactly like a smaller corpus.
 *
 * ## Order is a dependency chain, not a preference
 *
 * sync → validate → fingerprint → signatures → cluster. Each stage consumes what the one
 * before it produced: validation needs fetched bundles, fingerprints are only extracted for
 * judged versions, signatures are built from indexed ones, clustering needs the signatures.
 * Running them out of order is not wrong so much as pointless — the later stage finds
 * nothing to do.
 *
 * ## Bounded, resumable, and it does not stop on failure
 *
 * Every stage takes a slice, because a serverless invocation is capped and the corpus is
 * bigger than one run. A stage that throws is recorded and the rest still run: a GitHub
 * rate limit during sync must not also cost the fingerprints of everything already fetched,
 * which is the failure mode a naive `await` chain has.
 */

/**
 * How long the sync stage may spend starting new sources.
 *
 * Generous enough for five ordinary repositories, short enough that a pass still returns
 * and the derived stages behind it still run. The derived stages are the ones that fall
 * behind, and they must not be starved by a fetch that never ends.
 */
const DEFAULT_SYNC_BUDGET_MS = 8 * 60_000;

export type StageResult = {
  stage: string;
  ok: boolean;
  detail: string;
};

export type PipelineReport = {
  stages: StageResult[];
  /** True when every stage ran without throwing. */
  ok: boolean;
};

export type PipelineOptions = {
  /** Sources to fetch this pass. The expensive stage; keep it small. */
  sources?: number;
  /** Versions to judge. Rules only — the LLM analyzers are never part of this. */
  validate?: number;
  /** Bundles to fingerprint. */
  structures?: number;
  /** Bundles to sign for dedup. */
  signatures?: number;
  /** Candidate pairs to compare when clustering. */
  pairs?: number;
  /** Skip fetching and only catch the derived stages up. */
  skipSync?: boolean;
  /** Who started this pass — `cron`, `admin`, or the CLI. Recorded on the event. */
  trigger?: string;
  /**
   * Wall-clock budget for the sync stage, in milliseconds.
   *
   * A slice bounded only by *count* is not bounded at all when one item can be arbitrarily
   * large. `davila7/claude-code-templates` holds 898 skills — roughly 3,600 file fetches —
   * and `syncSource` deliberately fetches a source completely, because a partial
   * enumeration would make R1.5's tombstoning delete everything it did not reach. So one
   * source in a five-source slice ran past the job's wall clock and the whole loop was
   * killed mid-pass, twice, at exactly the same source.
   */
  syncBudgetMs?: number;
  onProgress?: (message: string) => void;
};

/** Runs one stage, converting a throw into a recorded failure. */
async function stage(
  name: string,
  report: PipelineReport,
  log: (m: string) => void,
  run: () => Promise<string>,
): Promise<void> {
  log(`▸ ${name}`);
  try {
    const detail = await run();
    report.stages.push({ stage: name, ok: true, detail });
    log(`  ${detail}`);
  } catch (error) {
    const detail = (error as Error).message.slice(0, 300);
    report.stages.push({ stage: name, ok: false, detail });
    report.ok = false;
    // Recorded, not rethrown. One stage failing must not cost the work of the others.
    log(`  failed: ${detail}`);
  }
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineReport> {
  const log = options.onProgress ?? (() => {});
  const report: PipelineReport = { stages: [], ok: true };
  const startedAt = Date.now();

  if (!options.skipSync) {
    await stage("sync", report, log, async () => {
      const targets = await pendingSources(options.sources ?? 5);
      if (targets.length === 0) return "no sources awaiting a first sync";

      const budgetMs = options.syncBudgetMs ?? DEFAULT_SYNC_BUDGET_MS;
      const deadline = Date.now() + budgetMs;

      let created = 0;
      let tombstoned = 0;
      let failed = 0;
      let skippedSkills = 0;
      let attempted = 0;
      let deferred = 0;

      for (const target of targets) {
        /**
         * Checked before starting, never during.
         *
         * A source in flight is fetched to completion or not at all — abandoning one
         * halfway would leave a partial enumeration, and R1.5 treats "absent from the
         * enumeration" as "deleted upstream". So the budget stops the *next* source from
         * starting, which bounds the overrun to one source rather than the whole queue.
         */
        if (Date.now() >= deadline) {
          deferred = targets.length - attempted;
          break;
        }
        attempted += 1;

        try {
          const result = await syncSource({ sourceUrl: target.url });
          created += result.created;
          tombstoned += result.tombstoned;
          skippedSkills += result.failedSkills.length;
        } catch {
          // Per-source, so one unreachable repository does not end the slice.
          failed += 1;
        }
      }

      return (
        `${attempted} source(s): ${created} version(s) created, ${tombstoned} tombstoned, ${failed} failed` +
        // Distinct from a failed *source*: the repository synced, some skills in it did not.
        (skippedSkills > 0 ? `, ${skippedSkills} skill(s) skipped` : "") +
        (deferred > 0 ? ` · ${deferred} deferred, time budget spent` : "")
      );
    });
  }

  await stage("validate", report, log, async () => {
    const outcomes = await validatePending({ limit: options.validate ?? 500 });
    if (outcomes.length === 0) return "nothing awaiting a verdict";
    const indexed = outcomes.filter((o) => o.status === "indexed").length;
    return `${outcomes.length} judged: ${indexed} indexed, ${outcomes.length - indexed} quarantined`;
  });

  await stage("fingerprint", report, log, async () => {
    const result = await extractStructures({ limit: options.structures ?? 500 });
    if (result.extracted === 0 && result.remaining === 0) return "nothing to fingerprint";
    return `${result.extracted} extracted, ${result.failed} failed, ${result.remaining} remaining`;
  });

  await stage("signatures", report, log, async () => {
    const result = await buildSignatures({ limit: options.signatures ?? 500 });
    if (result.processed === 0 && result.skipped === 0) return "no signatures to build";
    return `${result.processed} built, ${result.skipped} skipped, ${result.failed} failed`;
  });

  await stage("cluster", report, log, async () => {
    const result = await clusterDuplicates({ maxPairs: options.pairs ?? 400 });
    if (result.candidatePairs === 0) return "no candidate pairs to compare";
    return `${result.candidatePairs} pair(s) compared, ${result.confirmed} confirmed, ${result.variantsMarked} variant(s) marked`;
  });

  /**
   * Every pass leaves a record.
   *
   * Without one a schedule is unobservable: "it is running" and "it has been failing since
   * Tuesday" look identical from the outside, and R1.7 asks for source health precisely so
   * that difference is visible. One row per pass, in the same `events` spine everything
   * else audits through.
   */
  await db.insert(events).values({
    actorType: "system",
    actorId: options.trigger ?? "pipeline",
    kind: report.ok ? "pipeline.completed" : "pipeline.partial",
    subjectType: "pipeline",
    reason: report.stages.map((s) => `${s.stage}: ${s.detail}`).join(" · ").slice(0, 500),
    payload: {
      elapsedMs: Date.now() - startedAt,
      stages: report.stages,
      trigger: options.trigger ?? "manual",
    },
  });

  return report;
}

export type PipelineRun = {
  at: Date;
  ok: boolean;
  trigger: string;
  elapsedMs: number | null;
  stages: StageResult[];
};

/** Recent passes, newest first — what the admin panel shows about the schedule. */
export async function recentRuns(limit = 10): Promise<PipelineRun[]> {
  const rows = await db
    .select({
      at: events.at,
      kind: events.kind,
      payload: events.payload,
    })
    .from(events)
    .where(inArray(events.kind, ["pipeline.completed", "pipeline.partial"]))
    .orderBy(desc(events.at))
    .limit(limit);

  return rows.map((row) => {
    const payload = (row.payload ?? {}) as {
      elapsedMs?: number;
      stages?: StageResult[];
      trigger?: string;
    };
    return {
      at: row.at,
      ok: row.kind === "pipeline.completed",
      trigger: payload.trigger ?? "manual",
      elapsedMs: payload.elapsedMs ?? null,
      stages: payload.stages ?? [],
    };
  });
}

export type PipelineBacklog = {
  /** Sources enabled, never successfully synced. The denominator for the `sources` input. */
  sourcesAwaitingSync: number;
  /** Versions fetched but not yet judged. */
  awaitingValidation: number;
  /** Judged versions with no structural fingerprint at the current extractor version. */
  awaitingFingerprint: number;
  /** Indexed versions with no dedup signature. */
  awaitingSignature: number;
};

/**
 * What each stage would find to do right now.
 *
 * Exists because a control reading "5 sources" answers neither *five out of how many* nor
 * *what happens if I make it ten*. A slice size is meaningless without its queue depth, and
 * the derived stages have no input at all — their sizes are defaults the operator cannot
 * see. Showing the backlog turns the panel from a set of levers into a description of the
 * work outstanding.
 *
 * Four cheap counts. Deliberately not cached: a number that lags the thing it describes is
 * worse than no number on a panel whose whole job is telling you whether to press the
 * button again.
 */
export async function pipelineBacklog(): Promise<PipelineBacklog> {
  const [sourceRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sources)
    .where(
      and(
        isNull(sources.lastSuccessAt),
        eq(sources.enabled, true),
        ne(sources.kind, "awesome_list"),
      ),
    );

  const [validationRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(inArray(skillVersions.status, ["pending", "validating", "revalidating"]));

  const [fingerprintRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(
      and(
        inArray(skillVersions.status, ["indexed", "quarantined"]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(skillStructures)
            .where(
              and(
                eq(skillStructures.skillVersionId, skillVersions.id),
                eq(skillStructures.extractorVersion, EXTRACTOR_VERSION),
              ),
            ),
        ),
      ),
    );

  return {
    sourcesAwaitingSync: sourceRow?.count ?? 0,
    awaitingValidation: validationRow?.count ?? 0,
    awaitingFingerprint: fingerprintRow?.count ?? 0,
    awaitingSignature: await pendingSignatureCount(),
  };
}
