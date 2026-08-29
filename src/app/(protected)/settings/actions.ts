"use server";

import { revalidatePath } from "next/cache";

import { buildSignatures, clusterDuplicates } from "@/server/analytics/dedupe";
import { runCrawl, ensureSeedShards } from "@/server/crawl/run";
import { decideCandidates, enrichCandidates } from "@/server/crawl/promote";
import { requireAdmin, setUserBanned, setUserRole } from "@/server/dal/admin";
import { pendingSources, syncSource } from "@/server/ingest/sync";
import { validatePending } from "@/server/validation/run";

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
