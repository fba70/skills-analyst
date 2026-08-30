"use server";

import { revalidatePath } from "next/cache";

import { buildSignatures, clusterDuplicates } from "@/server/analytics/dedupe";
import { extractStructures } from "@/server/analytics/structure-run";
import { expandList, applySeedRepos } from "@/server/crawl/seed-run";
import { normalizeRepoInput, submitRepository } from "@/server/crawl/submit";
import { runCrawl, ensureSeedShards } from "@/server/crawl/run";
import { decideCandidates, enrichCandidates } from "@/server/crawl/promote";
import { requireAdmin, setUserBanned, setUserRole } from "@/server/dal/admin";
import {
  approveRepo,
  rejectRepo,
  releaseFromQuarantine,
} from "@/server/dal/curation";
import { pendingSources, syncSource } from "@/server/ingest/sync";
import { MAX_BATCH } from "@/server/taxonomy/classify";
import { classifySample, reviewCategory, type SampleStrategy } from "@/server/taxonomy/run";
import { validatePending, versionsWithCode } from "@/server/validation/run";

/**
 * Admin operations.
 *
 * **Every action re-checks `requireAdmin()`.** A server action is a POST endpoint: the
 * page-level guard controls who sees the button, not who can call it. Anyone who knows
 * the action id can invoke it directly, so the check has to live here.
 *
 * All of these are deliberately **bounded**. A full crawl is days and a full sync is
 * hours, while a serverless function is capped at 800 s (Doc 3 C2) — so each run does a
 * slice and reports what it did. The real answer is the cron dispatcher and durable
 * workflows from Doc 3; these buttons are for running a slice on demand and watching what
 * happens, which is exactly what tuning the policy needs.
 */

export type ActionResult = { ok: boolean; message: string };

function failure(error: unknown): ActionResult {
  return { ok: false, message: (error as Error).message.slice(0, 300) };
}

export async function runCrawlAction(shards: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    await ensureSeedShards();
    const report = await runCrawl({
      maxShards: Math.min(Math.max(1, shards), 10),
      maxRequests: 30,
    });
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `${report.shardsProcessed} shard(s), ${report.itemsSeen} marker(s), ` +
        `${report.reposDiscovered} new repo(s), ${report.shardsSplit} split — ` +
        `stopped: ${report.stoppedBecause}`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function promoteAction(enrich: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const enriched = await enrichCandidates(Math.min(Math.max(1, enrich), 100));
    const decided = await decideCandidates();
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `enriched ${enriched.enriched} (${enriched.missing} unavailable) · ` +
        `promoted ${decided.promoted}, held ${decided.review}, skipped ${decided.skipped}`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function syncPendingAction(limit: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    // Small by default: one large repository can take minutes on its own.
    const targets = await pendingSources(Math.min(Math.max(1, limit), 5));
    if (targets.length === 0) {
      return { ok: true, message: "No sources are awaiting a first sync." };
    }

    let created = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const report = await syncSource({ sourceUrl: target.url });
        created += report.created;
      } catch {
        failed += 1;
      }
    }
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message: `${targets.length} source(s): ${created} new skill version(s), ${failed} failed`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function validateAction(limit: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const outcomes = await validatePending({ limit: Math.min(Math.max(1, limit), 200) });
    const indexed = outcomes.filter((outcome) => outcome.status === "indexed").length;
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message: `${outcomes.length} validated: ${indexed} indexed, ${outcomes.length - indexed} quarantined`,
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Deduplication, as two triggers rather than one.
 *
 * Signatures read every validated bundle; clustering re-reads only the bundles of
 * candidate pairs, to confirm each with an exact Jaccard rather than a MinHash estimate.
 * Both therefore need bounding, and both are resumable.
 */
export async function signaturesAction(limit: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const report = await buildSignatures({ limit: Math.min(Math.max(1, limit), 500) });
    revalidatePath("/settings");
    return {
      ok: true,
      message: `${report.processed} signature(s) built · ${report.skipped} skipped (no text) · ${report.failed} failed`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function clusterAction(maxPairs: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const report = await clusterDuplicates({
      maxPairs: Math.min(Math.max(1, maxPairs), 2000),
    });
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message:
        `${report.candidatePairs} candidate(s) · ${report.confirmed} confirmed · ` +
        `${report.rejectedByDescription} rejected as template siblings · ` +
        `${report.variantsMarked} variant(s) in ${report.clusters} cluster(s)` +
        (report.stoppedEarly ? " — pair budget spent, run again to continue" : ""),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function approveRepoAction(repoId: string): Promise<ActionResult> {
  try {
    await approveRepo(repoId);
    revalidatePath("/settings");
    return { ok: true, message: "Approved — it will sync on the next run." };
  } catch (error) {
    return failure(error);
  }
}

export async function rejectRepoAction(
  repoId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    await rejectRepo(repoId, reason);
    revalidatePath("/settings");
    return { ok: true, message: "Rejected and recorded." };
  } catch (error) {
    return failure(error);
  }
}

export async function releaseAction(
  versionId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    await releaseFromQuarantine(versionId, reason);
    revalidatePath("/settings");
    revalidatePath("/skills");
    return { ok: true, message: "Released — the original verdicts are kept as history." };
  } catch (error) {
    return failure(error);
  }
}

export async function setRoleAction(userId: string, role: "admin" | "user"): Promise<ActionResult> {
  try {
    await setUserRole(userId, role);
    revalidatePath("/settings");
    return { ok: true, message: `Role set to ${role}.` };
  } catch (error) {
    return failure(error);
  }
}

export async function setBannedAction(userId: string, banned: boolean): Promise<ActionResult> {
  try {
    await setUserBanned(userId, banned);
    revalidatePath("/settings");
    return { ok: true, message: banned ? "User banned." : "User unbanned." };
  } catch (error) {
    return failure(error);
  }
}


/**
 * Structural fingerprints (R3.2).
 *
 * Rule-based and free, so the only bound that matters is the request timeout — hence a
 * slice size rather than "everything", same as the other stages.
 */
export async function extractStructuresAction(limit: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const report = await extractStructures({
      limit: Math.min(Math.max(1, limit), 500),
    });
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `fingerprinted ${report.extracted}, failed ${report.failed} · ` +
        `${report.remaining} remaining · ` +
        `${report.unresolvedHeadings.length} unrecognised heading string(s)`,
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Category classification (R3.1) — **the one action that spends money.**
 *
 * Capped twice: `MAX_BATCH` in the classifier, and again here. An admin action is a POST
 * endpoint like any other, so the UI's number input is not a limit — this is. The cap is
 * deliberately low enough that a mis-click costs cents, and a wider run is a CLI decision
 * taken with the corpus in front of you.
 */
export async function classifySampleAction(
  limit: number,
  strategy: SampleStrategy,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const report = await classifySample({
      limit: Math.min(Math.max(1, limit), MAX_BATCH),
      strategy,
    });
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message:
        `classified ${report.classified}/${report.requested}, failed ${report.failed} · ` +
        `${report.assignments} assignment(s), ${report.held} held for review · ` +
        `${report.remaining} unlabelled` +
        (report.errors.length > 0 ? ` · ${report.errors[0]}` : ""),
    };
  } catch (error) {
    return failure(error);
  }
}

/** A curator's verdict on one low-confidence assignment. */
export async function reviewCategoryAction(
  categoryId: string,
  decision: "confirm" | "reject",
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    await reviewCategory(categoryId, decision, admin.email);
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message: decision === "confirm" ? "Confirmed." : "Removed from this skill.",
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Admin repository submission (R1.8).
 *
 * `autoPromote: true` because an admin submitting a repository *is* the promotion
 * decision — the policy in `policy.ts` exists to judge repositories nobody looked at. The
 * public half of R1.8 will call the same function with `false` and land in the review
 * queue instead; nothing else changes.
 */
export async function submitRepoAction(
  url: string,
  includePaths: string,
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const outcome = await submitRepository(url, {
      submittedBy: admin.email,
      autoPromote: true,
      includePaths: includePaths
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter(Boolean),
    });

    if (!outcome.ok) return { ok: false, message: outcome.reason };

    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `${outcome.owner}/${outcome.repo}: ${outcome.skillsFound} skill(s) found, ` +
        `licence ${outcome.licenseSpdx ?? "unresolved"}` +
        (outcome.alreadyKnown ? ` — already known, updated` : "") +
        ` · run Sync to fetch them`,
    };
  } catch (error) {
    return failure(error);
  }
}


/**
 * Expand a curated list into candidates (R1.1b).
 *
 * The list is not fetched for content — only for the repository links inside it. Every
 * candidate then goes through the ordinary enrich → decide → sync → validate path, so
 * this cannot put an unvalidated skill in front of anyone. It is a discovery action.
 */
export async function expandListAction(url: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = normalizeRepoInput(url);
    const report = await expandList(
      { owner: parsed.owner, repo: parsed.repo },
      { submittedBy: admin.email },
    );
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `${report.list}: ${report.candidates} candidate(s) from ${report.linksSeen} link(s) · ` +
        `${report.inserted} new, ${report.alreadyKnown} already known · ` +
        `run Promote to enrich and decide on them`,
    };
  } catch (error) {
    return failure(error);
  }
}

/** Applies the whole curated seed allow-list. Bounded by the list's own length. */
export async function applySeedsAction(): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const report = await applySeedRepos({ submittedBy: admin.email });
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `${report.added} added, ${report.alreadyKnown} already known, ${report.failed} failed · ` +
        `${report.skillsFound} skill(s) reachable · run Sync to fetch them`,
    };
  } catch (error) {
    return failure(error);
  }
}


/**
 * R2.3 description-consistency — **the second action that spends money.**
 *
 * Targets only bundles that contain code, because a skill with no code cannot misrepresent
 * its code. Capped here as well as in the CLI: an admin action is a POST endpoint, so the
 * UI's number input is a suggestion and this is the limit.
 */
export async function consistencyAction(limit: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const bounded = Math.min(Math.max(1, limit), 25);
    const versionIds = await versionsWithCode(bounded);

    if (versionIds.length === 0) {
      return { ok: true, message: "No un-audited skills with bundled code. Nothing to do." };
    }

    const outcomes = await validatePending({
      versionIds,
      includeCostly: true,
      revalidate: true,
    });

    const flagged = outcomes.filter((o) => o.reasons.length > 0).length;
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message: `audited ${outcomes.length} skill(s) with bundled code · ${flagged} with findings`,
    };
  } catch (error) {
    return failure(error);
  }
}
