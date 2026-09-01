import "server-only";

import { and, desc, eq, gt, inArray, isNull, ne, notExists, sql } from "drizzle-orm";

import {
  buildSignatures,
  clusterDuplicates,
  pendingSignatureCount,
} from "@/server/analytics/dedupe";
import { db } from "@/server/db";
import {
  crawlShards,
  discoveredRepos,
  events,
  skillStructures,
  skillVersions,
  sources,
  verdicts,
} from "@/server/db/schema";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { extractStructures } from "@/server/analytics/structure-run";
import { pendingSources, SourceHeldForReviewError, syncSource } from "@/server/ingest/sync";
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
   * Refuse any source with more skills than this, deferring it for a dedicated run.
   *
   * For callers under a ceiling they cannot negotiate with. `syncBudgetMs` alone cannot
   * protect them: it is checked between sources, so a single oversized repository still
   * runs to completion or to the platform's kill — which is exactly how the scheduled pass
   * burned its full 800 s and died mid-fetch.
   */
  maxSkillsPerSource?: number;
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
      let relicensed = 0;
      let tombstoned = 0;
      let blocked = 0;
      /**
       * Which source failed and why — not a count.
       *
       * This used to be `failed += 1` with an empty catch, and the consequence showed up in
       * the live log: every pass for days reported "1 failed" and nothing anywhere said
       * which repository or what went wrong. A recurring failure that cannot be identified
       * is a cost you pay on every run and can never act on, and it is indistinguishable
       * from a different source failing each time.
       *
       * `syncSource` already learned this one level down — `failedSkills` carries a path and
       * a reason rather than a tally. The same rule belongs here.
       */
      const failedSources: Array<{ url: string; reason: string }> = [];
      /**
       * Withheld on purpose, and therefore not a failure.
       *
       * The marker gate disabling an 819-skill repository is the policy doing its job. Filed
       * under "failed" it inflates a number an operator is meant to react to, and the first
       * consequence of a failure count that is usually noise is that a real failure stops
       * being noticed.
       */
      const heldSources: Array<{ url: string; markerCount: number }> = [];
      let skippedSkills = 0;
      let deferredSources = 0;
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
          const result = await syncSource({
            sourceUrl: target.url,
            maxSkills: options.maxSkillsPerSource,
          });
          if (result.deferred) deferredSources += 1;
          created += result.created;
          relicensed += result.relicensed;
          tombstoned += result.tombstoned;
          blocked += result.blocked;
          skippedSkills += result.failedSkills.length;
        } catch (error) {
          // Per-source, so one unreachable repository does not end the slice.
          if (error instanceof SourceHeldForReviewError) {
            heldSources.push({ url: error.url, markerCount: error.markerCount });
            log(`held for review: ${error.url} — ${error.markerCount} skills, over the ${error.threshold} threshold`);
            continue;
          }
          const reason = error instanceof Error ? error.message : String(error);
          failedSources.push({ url: target.url, reason });
          // Logged as it happens as well as summarised, because a pass that dies later
          // still leaves this in the output.
          log(`sync failed: ${target.url} — ${reason}`);
        }
      }

      return (
        `${attempted} source(s): ${created} version(s) created, ${tombstoned} tombstoned, ${failedSources.length} failed` +
        // Named, not counted, and bounded so one broken connector cannot flood the summary.
        // Two is enough to tell "the same source every time" from "a different one each
        // pass", which is the only question this line has to answer.
        (failedSources.length > 0
          ? ` (${failedSources
              .slice(0, 2)
              .map((f) => `${f.url}: ${f.reason.slice(0, 80)}`)
              .join("; ")}${failedSources.length > 2 ? `; +${failedSources.length - 2} more` : ""})`
          : "") +
        // Reported rather than silent: a skill not fetched because of a takedown looks
        // exactly like a skill that was never there, and those need different responses.
        // Same bytes, better licence answer. Worth its own word: the corpus did not grow,
        // but skills that were unservable may have become downloadable.
        (relicensed > 0 ? `, ${relicensed} relicensed` : "") +
        // Named separately from failures: this one needs a curator, not a bug report.
        (heldSources.length > 0
          ? `, ${heldSources.length} held for review (${heldSources
              .slice(0, 2)
              .map((h) => `${h.url}: ${h.markerCount} skills`)
              .join("; ")})`
          : "") +
        (blocked > 0 ? `, ${blocked} withdrawn on request` : "") +
        // Distinct from a failed *source*: the repository synced, some skills in it did not.
        (skippedSkills > 0 ? `, ${skippedSkills} skill(s) skipped` : "") +
        // Distinct from the time budget: this source was too large to start at all.
        (deferredSources > 0 ? `, ${deferredSources} too large — held for review` : "") +
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
  /** Code-search shards not yet read. Saturated ones are excluded — they cannot advance. */
  shardsPending: number;
  /** Discovered repositories nobody has decided about. */
  reposAwaitingDecision: number;
  /**
   * Skills whose bundle contains code and carries no description-consistency verdict.
   *
   * The only queue here that **costs money** to work through, which is why it is counted
   * separately rather than folded into the validation figure — an operator sizing a free
   * pass and one sizing a billable one need different numbers in front of them.
   */
  skillsAwaitingAudit: number;
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

  const [shardRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crawlShards)
    // `saturated` is deliberately excluded: those are over the search cap and cannot be
    // advanced by reading them again, so counting them as work would misstate the queue as
    // permanently unfinishable.
    .where(inArray(crawlShards.status, ["pending", "running"]));

  const [repoRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(discoveredRepos)
    .where(eq(discoveredRepos.status, "new"));

  /**
   * Bundles with code and no current R2.3 verdict.
   *
   * Mirrors `versionsWithCode`'s selector rather than re-deriving it: the number an
   * operator reads beside the input has to be the number the run will actually draw from,
   * or the denominator is fiction.
   */
  const [auditRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.status, "indexed"),
        gt(skillVersions.fileCount, 1),
        notExists(
          db
            .select({ one: sql`1` })
            .from(verdicts)
            .where(
              and(
                eq(verdicts.skillVersionId, skillVersions.id),
                eq(verdicts.analyzer, "description-consistency"),
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
    shardsPending: shardRow?.count ?? 0,
    reposAwaitingDecision: repoRow?.count ?? 0,
    skillsAwaitingAudit: auditRow?.count ?? 0,
  };
}
