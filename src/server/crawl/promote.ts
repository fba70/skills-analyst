import "server-only";
import { fetchWithDeadline } from "@/server/http/deadline";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { discoveredRepos, events, sources } from "@/server/db/schema";

import { decidePromotion, discoveryPolicy, isExcludedPath, type PromotionDecision } from "./policy";

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
    "user-agent": "skills-foundry",
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
      const response = await fetchWithDeadline(`${API}/repos/${candidate.owner}/${candidate.repo}`, {
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
      // hitCount 0 with a submitter means a curated list named it rather than the crawl
      // counting markers in it — different evidence, and the policy weighs it differently.
      fromCuratedList: candidate.hitCount === 0 && candidate.submittedBy !== null,
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

/**
 * Re-judges sources paused for holding too many markers, after the threshold moves.
 *
 * The sibling of `reapplyPathExclusions`, and the same reasoning: a policy constant that
 * changes is worthless if the rows it already decided keep the old answer forever. A paused
 * source is `enabled = false`, so `pendingSources` skips it — without this, raising the
 * threshold would apply to repositories discovered *next* and silently leave the 32 already
 * held sitting there, which looks exactly like the change not working.
 *
 * Offline and re-runnable: no network, so it costs nothing to run after every threshold
 * change, in either direction. Sources carrying an explicit `allowLargeRepo` approval are
 * left alone — a curator already decided those, and a policy sweep must not overwrite a
 * human decision.
 */
export async function reapplyMarkerThreshold(): Promise<{
  reEnabled: number;
  stillHeld: number;
}> {
  /**
   * Every disabled **public discovery** source, not only the ones marked `paused`.
   *
   * Two conditions, and both were learned the hard way:
   *
   * `health = 'paused'` was dropped because a curator-approved source sits at
   * `health: 'unknown'` after approval — which is exactly the row this sweep exists to
   * unstick, and exactly the row that filter excluded.
   *
   * `org_id is null` was added the moment the first filter came off. Every organisation
   * has a `builder` source that is `enabled = false` **by design**, so the scheduler never
   * offers it — it is where publish-back files authored skills, not a repository anyone can
   * fetch. A sweep that re-enabled it would queue a source with no upstream to sync.
   */
  const paused = await db
    .select({
      id: sources.id,
      url: sources.url,
      config: sources.config,
      detail: sources.healthDetail,
    })
    .from(sources)
    .where(and(eq(sources.enabled, false), isNull(sources.orgId)));

  let reEnabled = 0;
  let stillHeld = 0;

  for (const row of paused) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const detail = (row.detail ?? {}) as Record<string, unknown>;

    /**
     * An approval means "sync this", so a disabled approved source is re-enabled here.
     *
     * This guard used to `continue`, on the reasoning that a curator had already decided and
     * the sweep should not overrule them. That is right about *re-pausing* and exactly wrong
     * here: the decision was to admit the repository, and skipping it left the approval
     * inert. Two sources sat disabled-and-approved indefinitely — the sweep would not touch
     * them because they looked decided, and nothing else re-enables a source. Honouring the
     * decision is the opposite of overruling it.
     */
    if (config.allowLargeRepo === true) {
      await releaseSource(row.id, row.url, `curator-approved (allowLargeRepo)`);
      reEnabled += 1;
      continue;
    }

    /**
     * A pass-ceiling hold is not a judgement about the repository.
     *
     * It records that one caller could not finish inside its own budget. A local run has no
     * ceiling, so the source should go back in the queue rather than wait for a review
     * nobody needs to perform.
     */
    if (detail.heldBy === "pass-ceiling") {
      await releaseSource(row.id, row.url, "held by a pass ceiling, not by review policy");
      reEnabled += 1;
      continue;
    }

    let markerCount = typeof detail.markerCount === "number" ? detail.markerCount : null;

    if (markerCount === null && typeof detail.reason === "string") {
      // Rows paused before the count was stored structurally still carry it in the reason
      // sentence: "3551 skills in one repository — over the 50 threshold".
      const parsed = detail.reason.match(/^(\d+)\s+skills\b/);
      if (parsed) markerCount = Number(parsed[1]);
    }

    /**
     * Deliberately NOT falling back to `discovered_repos.hit_count`.
     *
     * It looks like the same number and is not. `hit_count` is how many markers *code
     * search* reported, which is capped and sampled; the pause records how many a full
     * enumeration found. Using one for the other let a repository whose enumeration found
     * 3,551 markers past a 500 threshold because code search had only seen a handful of
     * them. The sync re-pauses it on the next pass, so nothing is fetched — but the
     * re-apply then reports "0 still held" when two were, which is a lie in the one place
     * you are looking to check whether the change did what you meant.
     */
    if (markerCount === null) {
      stillHeld += 1;
      continue;
    }

    if (markerCount > discoveryPolicy.markerCountReviewThreshold) {
      stillHeld += 1;
      continue;
    }

    await releaseSource(
      row.id,
      row.url,
      `${markerCount} markers now under the ${discoveryPolicy.markerCountReviewThreshold} threshold`,
    );
    reEnabled += 1;
  }

  return { reEnabled, stillHeld };
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

/**
 * Puts a disabled source back in the queue, with a record of why.
 *
 * One implementation for all three release paths — an approval being honoured, a transient
 * pass-ceiling hold expiring, and a threshold that moved. They differ only in the sentence,
 * and three copies of this transaction would be three places for the `discovered_repos`
 * update to be forgotten.
 */
async function releaseSource(id: string, url: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(sources)
      .set({ enabled: true, health: "unknown", healthDetail: null, updatedAt: new Date() })
      .where(eq(sources.id, id));

    await tx
      .update(discoveredRepos)
      .set({ status: "promoted", skipReason: null })
      .where(eq(discoveredRepos.url, url));

    await tx.insert(events).values({
      actorType: "system",
      actorId: "crawl.policy",
      kind: "source.threshold_reapplied",
      subjectType: "sources",
      subjectId: id,
      reason,
      payload: { url, reason },
    });
  });
}
