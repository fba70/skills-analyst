import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { discoveredRepos, events, sources } from "@/server/db/schema";

import { decidePromotion, isExcludedPath, type PromotionDecision } from "./policy";

/**
 * Turning discovered repositories into things we actually sync.
 *
 * Two steps, deliberately separate:
 *   1. **enrich** — one API call per candidate for stars, archived, last push. Costs
 *      budget, so it is bounded and resumable.
 *   2. **decide** — pure, from stored facts. No network, so the rules can be re-run over
 *      the whole table for free whenever the policy changes, which it will.
 *
 * Every decision is written with its reason and an `events` row. A candidate is never
 * deleted: skipped repositories keep their reason so a later policy change is a re-run
 * rather than a re-crawl.
 */

const API = "https://api.github.com";

type RepoMeta = {
  stargazers_count: number;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  pushed_at: string | null;
  parent?: { full_name: string };
};

function headers(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "skill-foundry",
  };
}

export type EnrichReport = { enriched: number; missing: number; failed: number };

/** Fills in the facts the decision needs. Bounded: this is the expensive half. */
export async function enrichCandidates(limit = 50): Promise<EnrichReport> {
  const candidates = await db
    .select({
      id: discoveredRepos.id,
      owner: discoveredRepos.owner,
      repo: discoveredRepos.repo,
    })
    .from(discoveredRepos)
    .where(and(eq(discoveredRepos.status, "new"), isNull(discoveredRepos.enrichedAt)))
    .orderBy(desc(discoveredRepos.hitCount))
    .limit(limit);

  const report: EnrichReport = { enriched: 0, missing: 0, failed: 0 };

  for (const candidate of candidates) {
    try {
      const response = await fetch(`${API}/repos/${candidate.owner}/${candidate.repo}`, {
        headers: headers(),
      });

      if (response.status === 404 || response.status === 451) {
        // Deleted, renamed or taken down between crawl and enrichment. Not an error —
        // record it and move on, so it is never retried in a loop.
        await db
          .update(discoveredRepos)
          .set({
            status: "skipped",
            skipReason: `repository unavailable (${response.status})`,
            enrichedAt: new Date(),
          })
          .where(eq(discoveredRepos.id, candidate.id));
        report.missing += 1;
        continue;
      }

      if (!response.ok) {
        report.failed += 1;
        continue;
      }

      const meta = (await response.json()) as RepoMeta;
      await db
        .update(discoveredRepos)
        .set({
          stars: meta.stargazers_count,
          isFork: meta.fork,
          parentRepo: meta.parent?.full_name ?? null,
          archived: meta.archived,
          defaultBranch: meta.default_branch,
          pushedAt: meta.pushed_at ? new Date(meta.pushed_at) : null,
          enrichedAt: new Date(),
          status: "enriched",
        })
        .where(eq(discoveredRepos.id, candidate.id));
      report.enriched += 1;
    } catch {
      report.failed += 1;
    }
  }

  return report;
}

export type DecideReport = {
  promoted: number;
  review: number;
  skipped: number;
  byReason: Record<string, number>;
};

/**
 * Applies the policy to everything enriched. Pure and re-runnable: no network, so a
 * threshold change costs nothing to re-evaluate across the whole table.
 */
export async function decideCandidates(options: { limit?: number } = {}): Promise<DecideReport> {
  const candidates = await db
    .select()
    .from(discoveredRepos)
    .where(inArray(discoveredRepos.status, ["enriched", "needs_review"]))
    .orderBy(desc(discoveredRepos.stars))
    .limit(options.limit ?? 1000);

  const report: DecideReport = { promoted: 0, review: 0, skipped: 0, byReason: {} };

  for (const candidate of candidates) {
    const decision = decidePromotion({
      hitCount: candidate.hitCount,
      samplePaths: candidate.samplePaths,
      isFork: candidate.isFork,
      archived: candidate.archived,
      stars: candidate.stars,
      pushedAt: candidate.pushedAt,
    });

    report.byReason[decision.reason] = (report.byReason[decision.reason] ?? 0) + 1;

    if (decision.action === "promote") {
      await promote(candidate.id, candidate.url, candidate.owner, candidate.repo, decision);
      report.promoted += 1;
    } else {
      await db
        .update(discoveredRepos)
        .set({
          status: decision.action === "review" ? "needs_review" : "skipped",
          skipReason: decision.reason,
        })
        .where(eq(discoveredRepos.id, candidate.id));
      if (decision.action === "review") report.review += 1;
      else report.skipped += 1;
    }
  }

  return report;
}

/** Creates the `sources` row that makes a repository syncable. */
async function promote(
  candidateId: string,
  url: string,
  owner: string,
  repo: string,
  decision: PromotionDecision,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.url, url), isNull(sources.orgId)))
      .limit(1);

    let sourceId = existing?.id;
    if (!sourceId) {
      const [created] = await tx
        .insert(sources)
        .values({
          kind: "github_repo",
          name: `${owner}/${repo}`,
          url,
          config: { discoveredBy: "code-search" },
          health: "unknown",
        })
        .returning({ id: sources.id });
      sourceId = created.id;
    }

    await tx
      .update(discoveredRepos)
      .set({ status: "promoted", sourceId, skipReason: null })
      .where(eq(discoveredRepos.id, candidateId));

    await tx.insert(events).values({
      actorType: "system",
      actorId: "crawl.promote",
      kind: "discovered_repo.promoted",
      subjectType: "discovered_repos",
      subjectId: candidateId,
      reason: decision.reason,
      payload: { url, sourceId },
    });
  });
}

/**
 * Re-evaluates repositories whose sample paths are all excluded.
 *
 * Runs over rows discovered before the path filter existed. Cheap and offline — exactly
 * the kind of thing that should stay possible when the policy moves into settings.
 */
export async function reapplyPathExclusions(): Promise<number> {
  const rows = await db
    .select({ id: discoveredRepos.id, samplePaths: discoveredRepos.samplePaths })
    .from(discoveredRepos)
    .where(inArray(discoveredRepos.status, ["new", "enriched", "needs_review"]));

  let changed = 0;
  for (const row of rows) {
    const paths = row.samplePaths ?? [];
    if (paths.length === 0 || !paths.every(isExcludedPath)) continue;
    await db
      .update(discoveredRepos)
      .set({ status: "skipped", skipReason: "all markers under excluded paths" })
      .where(eq(discoveredRepos.id, row.id));
    changed += 1;
  }
  return changed;
}

export async function promotionSummary() {
  const rows = await db
    .select({
      status: discoveredRepos.status,
      count: sql<number>`count(*)::int`,
      stars: sql<number>`coalesce(max(${discoveredRepos.stars}), 0)::int`,
    })
    .from(discoveredRepos)
    .groupBy(discoveredRepos.status);

  const review = await db
    .select({
      name: sql<string>`${discoveredRepos.owner} || '/' || ${discoveredRepos.repo}`,
      hitCount: discoveredRepos.hitCount,
      stars: discoveredRepos.stars,
      reason: discoveredRepos.skipReason,
    })
    .from(discoveredRepos)
    .where(eq(discoveredRepos.status, "needs_review"))
    .orderBy(desc(discoveredRepos.hitCount))
    .limit(10);

  return { rows, review };
}
