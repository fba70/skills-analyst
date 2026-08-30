import "server-only";

import { and, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";

import {
  buildSignatures,
  clusterDuplicates,
  pendingSignatureCount,
} from "@/server/analytics/dedupe";
import { db } from "@/server/db";
import { skillStructures, skillVersions, sources } from "@/server/db/schema";
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

  if (!options.skipSync) {
    await stage("sync", report, log, async () => {
      const targets = await pendingSources(options.sources ?? 5);
      if (targets.length === 0) return "no sources awaiting a first sync";

      let created = 0;
      let tombstoned = 0;
      let failed = 0;
      for (const target of targets) {
        try {
          const result = await syncSource({ sourceUrl: target.url });
          created += result.created;
          tombstoned += result.tombstoned;
        } catch {
          // Per-source, so one unreachable repository does not end the slice.
          failed += 1;
        }
      }
      return `${targets.length} source(s): ${created} version(s) created, ${tombstoned} tombstoned, ${failed} failed`;
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

  return report;
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
