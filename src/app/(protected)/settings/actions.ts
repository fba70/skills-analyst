"use server";

import { revalidatePath } from "next/cache";

import { desc, eq, sql } from "drizzle-orm";

import { buildSignatures, clusterDuplicates } from "@/server/analytics/dedupe";
import { archetypeSummary, mineAll } from "@/server/analytics/archetype-run";
import { extractStructures } from "@/server/analytics/structure-run";
import { expandList, applySeedRepos } from "@/server/crawl/seed-run";
import { normalizeRepoInput, submitRepository } from "@/server/crawl/submit";
import { runCrawl, ensureSeedShards } from "@/server/crawl/run";
import { decideCandidates, enrichCandidates } from "@/server/crawl/promote";
import {
  recordTakedown,
  rejectTakedown,
  reinstateTakedown,
  upholdTakedown,
  type TakedownInput,
} from "@/server/compliance/takedown";
import { db } from "@/server/db";
import { skills, skillVersions, sources } from "@/server/db/schema";
import { requireAdmin, setUserBanned, setUserRole } from "@/server/dal/admin";
import { setSchedule, type ScheduleSettings } from "@/server/settings/schedule";
import {
  approveRepo,
  rejectRepo,
  releaseFromQuarantine,
} from "@/server/dal/curation";
import { pendingSources, syncSource } from "@/server/ingest/sync";
import { runPipeline } from "@/server/pipeline/run";
import { runRescan, staleSlices } from "@/server/validation/rescan";
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


/**
 * The whole ingest pipeline, one bounded pass (sync → validate → fingerprint → signatures
 * → cluster).
 *
 * The button that should be used most. Running stages individually is how the derived data
 * fell behind — fingerprints 1,566 short, signatures 2,240 — because each one is easy to
 * forget and its absence looks like a smaller corpus rather than an error.
 */
export async function runPipelineAction(sources: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const report = await runPipeline({
      trigger: "admin",
      sources: Math.min(Math.max(1, sources), 10),
    });
    revalidatePath("/settings");
    revalidatePath("/skills");
    revalidatePath("/dashboard");
    return {
      ok: report.ok,
      message: report.stages
        .map((stage) => `${stage.stage}: ${stage.detail}`)
        .join(" · "),
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Re-scan campaign (R2.12) — re-judge verdicts left behind by an analyzer version bump.
 *
 * Rules only, so it costs nothing; the LLM analyzers are deliberately not re-run by a
 * campaign, since a `structural-lint` fix is no reason to pay for a fresh R2.3 audit.
 */
export async function rescanAction(limit: number): Promise<ActionResult> {
  try {
    await requireAdmin();
    const report = await runRescan({ limit: Math.min(Math.max(1, limit), 500) });
    revalidatePath("/settings");
    revalidatePath("/skills");

    if (report.selected === 0) {
      return { ok: true, message: "Every verdict is at the current analyzer version." };
    }
    return {
      ok: true,
      message:
        `re-judged ${report.rejudged} · ${report.statusChanged} changed status · ` +
        `${report.scoreChanged} changed score · ${report.remaining} still stale`,
    };
  } catch (error) {
    return failure(error);
  }
}

/** Verdict freshness per analyzer, for the settings panel. Read-only. */
export async function verdictFreshness() {
  await requireAdmin();
  return staleSlices();
}


/**
 * Mine every function category's archetype (R3.2).
 *
 * Free — derived from stored fingerprints and labels, no model. Categories below the
 * evidence gate are skipped rather than mined thin, and the message says which, because
 * "nothing happened for 4 of 13 categories" is the useful half of the result.
 */
export async function mineArchetypesAction(): Promise<ActionResult> {
  try {
    await requireAdmin();
    const results = await mineAll();
    const stored = results.filter((r) => r.stored);
    const gated = results.filter((r) => !r.stored && r.reason.startsWith("below the"));

    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `${stored.length} archetype(s) written` +
        (gated.length > 0 ? ` · ${gated.length} below the evidence gate` : "") +
        (stored.length > 0 ? ` · ${stored.map((r) => r.category).join(", ")}` : ""),
    };
  } catch (error) {
    return failure(error);
  }
}

/** Latest archetype per category, for the settings panel. */
export async function archetypeRows() {
  await requireAdmin();
  return archetypeSummary();
}

/**
 * Takedowns (Doc 2 R7.5).
 *
 * Recording and deciding are separate actions because they are separate events, and
 * because they carry different risks: logging a notice is free and reversible, upholding
 * one deletes bytes from storage and un-lists content. A single "accept" button would make
 * the destructive half the default path.
 */
export async function recordTakedownAction(input: {
  scope: "skill" | "source";
  target: string;
  requester: string;
  requesterEmail: string;
  grounds: TakedownInput["grounds"];
  claim: string;
}): Promise<ActionResult> {
  try {
    await requireAdmin();

    const target = input.target.trim();
    if (!target) throw new Error("Name the skill slug or the repository URL.");
    if (!input.requester.trim()) throw new Error("Record who made the request.");
    if (!input.claim.trim()) throw new Error("Record what was claimed.");

    // A slug is what a curator has in front of them; the block needs (source url, path).
    // Resolving here rather than making them look it up is the difference between a form
    // someone uses under time pressure and one they get wrong.
    const resolved = await resolveTakedownTarget(input.scope, target);

    await recordTakedown({
      ...resolved,
      requester: input.requester.trim(),
      requesterEmail: input.requesterEmail.trim() || null,
      grounds: input.grounds,
      claim: input.claim.trim(),
    });

    revalidatePath("/settings");
    return { ok: true, message: "Request logged. Nothing is withdrawn until it is upheld." };
  } catch (error) {
    return failure(error);
  }
}

export async function upholdTakedownAction(id: string, note: string): Promise<ActionResult> {
  try {
    await requireAdmin();
    const result = await upholdTakedown(id, note.trim() || undefined);

    revalidatePath("/settings");
    revalidatePath("/skills");
    revalidatePath("/archetypes");

    return {
      ok: true,
      message:
        `${result.affectedSkills} skill(s) withdrawn · ${result.bundlesDeleted} bundle(s) ` +
        `deleted from storage` +
        (result.bundlesShared > 0
          ? ` · ${result.bundlesShared} kept, shared byte-for-byte with a skill not covered`
          : "") +
        (result.sourceDisabled ? " · source disabled" : ""),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function rejectTakedownAction(id: string, note: string): Promise<ActionResult> {
  try {
    await requireAdmin();
    await rejectTakedown(id, note);
    revalidatePath("/settings");
    return { ok: true, message: "Rejected. The claim stays on the record." };
  } catch (error) {
    return failure(error);
  }
}

export async function reinstateTakedownAction(id: string, note: string): Promise<ActionResult> {
  try {
    await requireAdmin();
    const result = await reinstateTakedown(id, note);
    revalidatePath("/settings");
    revalidatePath("/skills");
    return {
      ok: true,
      message:
        `Block lifted on ${result.unblocked} skill(s)` +
        (result.sourceReEnabled ? " · source re-enabled" : "") +
        ". Content returns on the next sync — the mirrored copy was deleted.",
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Turns what a curator has — a slug, or a repository URL — into the identity a block needs.
 *
 * `syncSource` matches an existing skill on `(source, path)`, so that pair is what a
 * takedown has to record. A slug is neither: it is ours, it is uniquified on collision, and
 * it does not survive a rebuild. Resolving it once, here, keeps the stored block correct
 * without asking a curator to read `provenance->>'path'` out of the database.
 */
async function resolveTakedownTarget(
  scope: "skill" | "source",
  target: string,
): Promise<Pick<TakedownInput, "scope" | "sourceUrl" | "skillPath" | "skillId" | "sourceId">> {
  if (scope === "source") {
    const { owner, repo } = normalizeRepoInput(target);
    const url = `https://github.com/${owner}/${repo}`;
    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.url, url))
      .limit(1);
    if (!source) throw new Error(`No source is registered at ${url}.`);
    return { scope: "source", sourceUrl: url, skillPath: null, skillId: null, sourceId: source.id };
  }

  const slug = target.replace(/^\/?skills\//, "");
  const [skill] = await db
    .select({
      id: skills.id,
      path: sql<string | null>`${skillVersions.provenance}->>'path'`,
      sourceId: sources.id,
      sourceUrl: sources.url,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
    .innerJoin(sources, eq(sources.id, skillVersions.sourceId))
    .where(eq(skills.slug, slug))
    .orderBy(desc(skillVersions.syncedAt))
    .limit(1);

  if (!skill) throw new Error(`No skill with slug "${slug}".`);
  if (skill.path === null) {
    throw new Error(`"${slug}" has no recorded upstream path, so a block cannot be keyed to it.`);
  }

  return {
    scope: "skill",
    sourceUrl: skill.sourceUrl,
    skillPath: skill.path,
    skillId: skill.id,
    sourceId: skill.sourceId,
  };
}


/**
 * Saves the ingest and refresh schedule (Doc 3, R1.7).
 *
 * `requireAdmin()` again, not because the page is guarded but because this is a POST
 * endpoint that decides whether the platform fetches anything at all — the single most
 * consequential toggle in the product.
 */
export async function saveScheduleAction(next: ScheduleSettings): Promise<ActionResult> {
  try {
    const actor = await requireAdmin();
    const saved = await setSchedule(next, actor);
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        `Ingestion ${saved.pipeline.enabled ? `on, every ${saved.pipeline.everyHours}h` : "off"}` +
        ` · archetype refresh ${
          saved.archetypes.enabled ? `on, every ${saved.archetypes.everyHours}h` : "off"
        }`,
    };
  } catch (error) {
    return failure(error);
  }
}
