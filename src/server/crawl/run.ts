import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { crawlShards, discoveredRepos, events } from "@/server/db/schema";

import { RateLimited, searchCode, type CodeSearchItem } from "./code-search";
import { isExcludedPath } from "./policy";
import {
  boundsFromJson,
  describeBounds,
  MAX_PAGES,
  queryFor,
  RESULT_CAP,
  seedBounds,
  splitBounds,
  type SizeBounds,
} from "./shards";

/**
 * One pass of the open crawl.
 *
 * Reads pending shards, records what each one found, and splits the ones GitHub
 * saturates. Every step commits before the next request, so stopping at any moment —
 * rate limit, deploy, Ctrl-C — leaves a ledger that resumes correctly rather than a
 * half-finished pass that has to be redone.
 *
 * Discovery only. Nothing is fetched from the repositories here: the crawl writes
 * candidates into `discovered_repos`, and promotion into `sources` is a separate,
 * explicit decision. That keeps the expensive part (two API calls per repo, then every
 * file) off the discovery path.
 */

export type CrawlOptions = {
  /** Stop after this many shards. The whole space is days of work. */
  maxShards?: number;
  /** Stop after this many search requests, whichever comes first. */
  maxRequests?: number;
  onProgress?: (message: string) => void;
};

export type CrawlReport = {
  shardsProcessed: number;
  requestsMade: number;
  itemsSeen: number;
  reposDiscovered: number;
  reposUpdated: number;
  shardsSplit: number;
  saturatedUnsplittable: number;
  stoppedBecause: string;
};

/** Creates the seed shards once; later runs resume whatever is pending. */
export async function ensureSeedShards(): Promise<number> {
  const rows = seedBounds().map((bounds) => ({
    query: queryFor(bounds),
    bounds: { min: bounds.min, max: bounds.max },
  }));

  const inserted = await db
    .insert(crawlShards)
    .values(rows)
    .onConflictDoNothing({ target: crawlShards.query })
    .returning({ id: crawlShards.id });

  return inserted.length;
}

export async function runCrawl(options: CrawlOptions = {}): Promise<CrawlReport> {
  const log = options.onProgress ?? (() => {});
  const maxShards = options.maxShards ?? 5;
  const maxRequests = options.maxRequests ?? 40;

  const report: CrawlReport = {
    shardsProcessed: 0,
    requestsMade: 0,
    itemsSeen: 0,
    reposDiscovered: 0,
    reposUpdated: 0,
    shardsSplit: 0,
    saturatedUnsplittable: 0,
    stoppedBecause: "no pending shards",
  };

  while (report.shardsProcessed < maxShards && report.requestsMade < maxRequests) {
    /**
     * Narrowest range first, not oldest first.
     *
     * The corpus is far denser than the seed ranges assume — a 128-byte-wide slice still
     * holds ~10,000 markers — so a breadth-first queue spends every request discovering
     * that yet another wide range is saturated, and collects nothing. Taking the narrowest
     * pending shard drives straight to ranges that fit under the cap and start returning
     * results, while the wide ones keep splitting in the background.
     */
    const [shard] = await db
      .select()
      .from(crawlShards)
      .where(and(eq(crawlShards.status, "pending"), isNull(crawlShards.orgId)))
      .orderBy(
        sql`coalesce((${crawlShards.bounds}->>'max')::bigint - (${crawlShards.bounds}->>'min')::bigint, 9223372036854775807) asc`,
        asc(crawlShards.createdAt),
      )
      .limit(1);

    if (!shard) break;

    const bounds = boundsFromJson(shard.bounds);
    log(`shard ${describeBounds(bounds)}  (${shard.query})`);

    await db
      .update(crawlShards)
      .set({
        status: "running",
        startedAt: new Date(),
        attempts: shard.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(crawlShards.id, shard.id));

    try {
      const outcome = await readShard(shard.id, shard.query, shard.pagesFetched, {
        remainingRequests: maxRequests - report.requestsMade,
        onProgress: log,
      });

      report.requestsMade += outcome.requests;
      report.itemsSeen += outcome.itemsSeen;
      report.reposDiscovered += outcome.discovered;
      report.reposUpdated += outcome.updated;

      if (outcome.saturated) {
        const children = splitBounds(bounds);
        if (children.length === 0) {
          // A single byte-size with >1,000 matches. The axis is exhausted; say so rather
          // than pretending the range was read.
          report.saturatedUnsplittable += 1;
          await finish(shard.id, "saturated", outcome, "range cannot be split further");
          log(`  saturated and unsplittable — ${outcome.reportedTotal} results unreachable`);
        } else {
          await splitShard(shard.id, children);
          report.shardsSplit += 1;
          await finish(shard.id, "saturated", outcome, "split into narrower shards");
          log(
            `  ${outcome.reportedTotal} results > cap — split into ${children
              .map(describeBounds)
              .join(", ")}`,
          );
        }
      } else if (outcome.exhaustedBudget) {
        // Out of request budget mid-shard: back to pending, resuming at the same page.
        await db
          .update(crawlShards)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(crawlShards.id, shard.id));
        report.stoppedBecause = "request budget spent";
        break;
      } else {
        await finish(shard.id, "complete", outcome, null);
        log(`  complete — ${outcome.itemsSeen} file(s), ${outcome.discovered} new repo(s)`);
      }

      report.shardsProcessed += 1;
    } catch (error) {
      if (error instanceof RateLimited) {
        await db
          .update(crawlShards)
          .set({
            status: "pending",
            lastError: error.message,
            updatedAt: new Date(),
          })
          .where(eq(crawlShards.id, shard.id));
        report.stoppedBecause = error.message;
        log(`  ${error.message}`);
        break;
      }

      await db
        .update(crawlShards)
        .set({
          status: "failed",
          lastError: (error as Error).message.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(crawlShards.id, shard.id));
      log(`  failed: ${(error as Error).message}`);
      report.shardsProcessed += 1;
    }
  }

  if (report.stoppedBecause === "no pending shards") {
    if (report.shardsProcessed >= maxShards) report.stoppedBecause = "shard limit reached";
    else if (report.requestsMade >= maxRequests) report.stoppedBecause = "request limit reached";
  }

  return report;
}

type ShardOutcome = {
  requests: number;
  pagesFetched: number;
  itemsSeen: number;
  discovered: number;
  updated: number;
  reportedTotal: number;
  saturated: boolean;
  exhaustedBudget: boolean;
};

async function readShard(
  shardId: string,
  query: string,
  startPage: number,
  context: { remainingRequests: number; onProgress: (message: string) => void },
): Promise<ShardOutcome> {
  const outcome: ShardOutcome = {
    requests: 0,
    pagesFetched: startPage,
    itemsSeen: 0,
    discovered: 0,
    updated: 0,
    reportedTotal: 0,
    saturated: false,
    exhaustedBudget: false,
  };

  for (let page = startPage + 1; page <= MAX_PAGES; page += 1) {
    if (outcome.requests >= context.remainingRequests) {
      outcome.exhaustedBudget = true;
      return outcome;
    }

    const result = await searchCode(query, page);
    outcome.requests += 1;
    outcome.reportedTotal = result.totalCount;

    if (page === 1 && result.totalCount > RESULT_CAP) {
      // Saturated: reading pages here would return a truncated, arbitrary slice.
      outcome.saturated = true;
      return outcome;
    }

    if (result.incompleteResults) {
      context.onProgress("  GitHub returned incomplete_results for this page");
    }

    const written = await recordItems(result.items);
    outcome.discovered += written.discovered;
    outcome.updated += written.updated;
    outcome.itemsSeen += result.items.length;
    outcome.pagesFetched = page;

    // Commit progress per page so a stop mid-shard resumes here.
    await db
      .update(crawlShards)
      .set({
        pagesFetched: page,
        itemsSeen: sql`${crawlShards.itemsSeen} + ${result.items.length}`,
        reportedTotal: result.totalCount,
        updatedAt: new Date(),
      })
      .where(eq(crawlShards.id, shardId));

    if (result.items.length < 1) break;
    if (page * result.items.length >= result.totalCount) break;
  }

  return outcome;
}

/**
 * Upserts the repositories behind a page of hits.
 *
 * Forks are recorded and marked skipped rather than dropped: they are the largest
 * duplicate class (Doc 2 R1.4), and keeping the row means a later decision to include
 * them is a status change instead of a re-crawl.
 */
async function recordItems(
  items: CodeSearchItem[],
): Promise<{ discovered: number; updated: number }> {
  const byRepo = new Map<string, { item: CodeSearchItem; paths: string[] }>();
  for (const item of items) {
    // Fixtures, vendored trees and build output are markers by shape, not skills. Drop
    // them here so they never reach the candidate table at all.
    if (isExcludedPath(item.path)) continue;
    const key = item.repository.fullName;
    const existing = byRepo.get(key);
    if (existing) existing.paths.push(item.path);
    else byRepo.set(key, { item, paths: [item.path] });
  }

  let discovered = 0;
  let updated = 0;

  for (const { item, paths } of byRepo.values()) {
    const isFork = item.repository.fork;
    const rows = await db
      .insert(discoveredRepos)
      .values({
        host: "github.com",
        owner: item.repository.owner,
        repo: item.repository.name,
        url: item.repository.htmlUrl,
        isFork,
        hitCount: paths.length,
        samplePaths: paths.slice(0, 5),
        status: isFork ? "skipped" : "new",
        skipReason: isFork ? "fork" : null,
      })
      .onConflictDoUpdate({
        /**
         * Expression target, matching `discovered_repos_uq` exactly.
         *
         * Migration 0021 folded that index to `(host, lower(owner), lower(repo))`. Postgres
         * infers the arbiter index from the ON CONFLICT target, and a bare column list
         * cannot match an expression index — it raises 42P10 rather than falling back. So
         * every discovery write threw until this matched: `pnpm crawl` on its first
         * repository, `pnpm registry --import` on the first of 2,422 rows, and `submit`
         * inside its transaction, recording neither source nor candidate.
         *
         * `verify:dedup` stayed green throughout, because it probes a raw INSERT — a shape
         * the application never uses. An ON CONFLICT target is a third reference to an
         * index, after the `where` clauses and the definition itself, and it is the one no
         * grep for a comparison operator can find.
         */
        target: [
          discoveredRepos.host,
          discoveredRepos.ownerFolded,
          discoveredRepos.repoFolded,
        ],
        set: {
          lastSeenAt: new Date(),
          hitCount: sql`${discoveredRepos.hitCount} + ${paths.length}`,
        },
      })
      .returning({ firstSeen: discoveredRepos.firstSeenAt, lastSeen: discoveredRepos.lastSeenAt });

    const row = rows[0];
    if (row && row.firstSeen.getTime() === row.lastSeen.getTime()) discovered += 1;
    else updated += 1;
  }

  return { discovered, updated };
}

async function splitShard(parentId: string, children: SizeBounds[]): Promise<void> {
  await db
    .insert(crawlShards)
    .values(
      children.map((bounds) => ({
        query: queryFor(bounds),
        bounds: { min: bounds.min, max: bounds.max },
        parentId,
      })),
    )
    .onConflictDoNothing({ target: crawlShards.query });
}

async function finish(
  shardId: string,
  status: "complete" | "saturated",
  outcome: ShardOutcome,
  note: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(crawlShards)
      .set({
        status,
        reportedTotal: outcome.reportedTotal,
        completedAt: new Date(),
        lastError: note,
        updatedAt: new Date(),
      })
      .where(eq(crawlShards.id, shardId));

    await tx.insert(events).values({
      actorType: "system",
      actorId: "crawl",
      kind: `crawl_shard.${status}`,
      subjectType: "crawl_shards",
      subjectId: shardId,
      reason: note,
      payload: {
        reportedTotal: outcome.reportedTotal,
        itemsSeen: outcome.itemsSeen,
        pagesFetched: outcome.pagesFetched,
        discovered: outcome.discovered,
      },
    });
  });
}

/** Coverage, stated honestly: what was read versus what exists. */
export async function crawlCoverage() {
  const rows = await db
    .select({
      status: crawlShards.status,
      shards: sql<number>`count(*)::int`,
      reported: sql<number>`coalesce(sum(${crawlShards.reportedTotal}), 0)::int`,
      seen: sql<number>`coalesce(sum(${crawlShards.itemsSeen}), 0)::int`,
    })
    .from(crawlShards)
    .groupBy(crawlShards.status);

  const [repos] = await db
    .select({
      total: sql<number>`count(*)::int`,
      forks: sql<number>`count(*) filter (where ${discoveredRepos.isFork})::int`,
      candidates: sql<number>`count(*) filter (where ${discoveredRepos.status} = 'new')::int`,
      promoted: sql<number>`count(*) filter (where ${discoveredRepos.status} = 'promoted')::int`,
    })
    .from(discoveredRepos);

  return { shards: rows, repos };
}
