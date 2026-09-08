import "server-only";

import { sql } from "drizzle-orm";

import {
  isPublishable,
  LOW_RESULT_THRESHOLD,
  MIN_DISTINCT_SEARCHERS,
  normaliseQuery,
  type DemandRow,
  type SearchChannel,
} from "@/lib/demand";
import { callerDigest, utcDay } from "@/server/analytics/outcomes";
import { db } from "@/server/db";
import { searchQueries } from "@/server/db/schema";

/**
 * Recording what people looked for, and publishing only what is safe to (RK.5, R5.3, step E3).
 *
 * ## The recorder is silent, and something else has to be loud
 *
 * `recordSearch` swallows its own failures. A reader must not get a 500 because a demand insert
 * hit a cold compute, and that is the posture the heartbeat and `recordOutcome` both settled on —
 * but it has cost this project once already, when `recordUsage` swallowed an RLS refusal and
 * builder spend was silently never metered.
 *
 * The defence is not to remove the swallow. `verify:demand` writes through the real recorder and
 * reads the row back, then repeats the call and asserts the count did not move. A hand-written
 * insert would prove the table works and nothing about whether the function meant to fill it does.
 */

export type RecordSearchInput = {
  query: string | null | undefined;
  resultCount: number;
  channel: SearchChannel;
  /** Something stable about the caller. Hashed with the day, never stored. */
  callerKey: string | null;
};

export async function recordSearch(input: RecordSearchInput): Promise<void> {
  try {
    const query = normaliseQuery(input.query ?? "");
    if (!query) return;

    const day = utcDay();
    await db
      .insert(searchQueries)
      .values({
        query,
        resultCount: Math.max(0, Math.trunc(input.resultCount)),
        channel: input.channel,
        day,
        callerDigest: callerDigest(input.callerKey, day),
      })
      /*
       * One row per searcher per query per channel per day. The conflict is the dedup, and the
       * update keeps the *latest* result count — a query that returned nothing this morning and
       * three skills this afternoon is no longer unmet, and the board should say so today rather
       * than tomorrow.
       */
      .onConflictDoUpdate({
        target: [
          searchQueries.query,
          searchQueries.channel,
          searchQueries.day,
          searchQueries.callerDigest,
        ],
        set: { resultCount: Math.max(0, Math.trunc(input.resultCount)), at: new Date() },
      });
  } catch (error) {
    console.warn(`[demand] search not recorded: ${(error as Error).message}`);
  }
}

/**
 * The most-wanted board: queries enough distinct people asked and the corpus could not answer.
 *
 * ## The floor is in the SQL, not in the caller
 *
 * `having count(distinct caller_digest) >= …` is what makes this page safe to serve, and it is
 * inside the query rather than applied after so that no caller can accidentally read the unfloored
 * rows and render them. `isPublishable` is re-applied on the way out — belt and braces, because a
 * `HAVING` clause is one keystroke from a leak and this is the one query in the codebase where
 * that keystroke is a disclosure rather than a bug.
 *
 * ## Median, not mean
 *
 * A query that returned nothing forty times and eleven results once has a mean of 0.27 and a
 * median of 0. The median says what a searcher actually experiences; the mean says what happened
 * to the corpus, and one outlier moves it.
 */
export async function mostWanted(options: { limit?: number; days?: number } = {}): Promise<
  DemandRow[]
> {
  const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
  const days = Math.max(1, Math.min(options.days ?? 90, 365));

  const rows = await db.execute(sql`
    select
      query,
      count(distinct caller_digest)::int as searchers,
      count(*)::int as searches,
      (percentile_cont(0.5) within group (order by result_count))::float as median_results,
      max(at) as last_searched_at
    from ${searchQueries}
    where at > now() - make_interval(days => ${days})
    group by query
    having count(distinct caller_digest) >= ${MIN_DISTINCT_SEARCHERS}
       and (percentile_cont(0.5) within group (order by result_count)) <= ${LOW_RESULT_THRESHOLD}
    order by count(distinct caller_digest) desc, count(*) desc
    limit ${limit}
  `);

  return (rows.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      query: row.query as string,
      searchers: Number(row.searchers),
      searches: Number(row.searches),
      medianResults: Math.round(Number(row.median_results) * 10) / 10,
      lastSearchedAt: new Date(row.last_searched_at as string),
    }))
    .filter(isPublishable);
}

/**
 * Coverage, so the board can say what it is a statement about.
 *
 * A most-wanted list with nothing on it means one of two opposite things — nobody is searching, or
 * everybody is finding what they came for — and a page that cannot tell them apart is the
 * `archetypes --blocks` mistake in a new place.
 */
export async function demandSummary() {
  const [row] = await db
    .select({
      searches: sql<number>`count(*)::int`,
      distinctQueries: sql<number>`count(distinct ${searchQueries.query})::int`,
      unmet: sql<number>`count(*) filter (where ${searchQueries.resultCount} = 0)::int`,
      /** Queries that *could* be published if their result counts were low enough. */
      abovefloor: sql<number>`(
        select count(*)::int from (
          select query from ${searchQueries}
          group by query
          having count(distinct caller_digest) >= ${MIN_DISTINCT_SEARCHERS}
        ) q
      )`,
      since: sql<string | null>`min(${searchQueries.at})`,
    })
    .from(searchQueries);

  return {
    searches: row?.searches ?? 0,
    distinctQueries: row?.distinctQueries ?? 0,
    unmet: row?.unmet ?? 0,
    aboveFloor: row?.abovefloor ?? 0,
    /* Converted at the boundary: `sql<T>` is a claim, not a parser. See `linkCheckSummary`. */
    since: row?.since ? new Date(row.since) : null,
  };
}

/**
 * Unmet demand that overlaps what an author is about to write (R5.3).
 *
 * This is the half of R5.3 that B3 could not do. Similarity tells an author twelve near-identical
 * skills already exist; this tells them nobody has written the thing people keep asking for — and
 * both belong beside the purpose field, where the answer can still change what gets built.
 *
 * Matched with `pg_trgm`, which migration 0017 already installed for search typo-tolerance. No
 * embedding call, so it is free and can render with the page rather than behind a button — the
 * distinction `findSimilarAction` had to draw because its match costs money and this one does not.
 */
export async function unmetNear(text: string, limit = 5): Promise<DemandRow[]> {
  const query = normaliseQuery(text);
  if (!query) return [];

  const rows = await db.execute(sql`
    select
      query,
      count(distinct caller_digest)::int as searchers,
      count(*)::int as searches,
      (percentile_cont(0.5) within group (order by result_count))::float as median_results,
      max(at) as last_searched_at
    from ${searchQueries}
    where query % ${query}
    group by query
    having count(distinct caller_digest) >= ${MIN_DISTINCT_SEARCHERS}
       and (percentile_cont(0.5) within group (order by result_count)) <= ${LOW_RESULT_THRESHOLD}
    order by similarity(query, ${query}) desc
    limit ${limit}
  `);

  return (rows.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      query: row.query as string,
      searchers: Number(row.searchers),
      searches: Number(row.searches),
      medianResults: Math.round(Number(row.median_results) * 10) / 10,
      lastSearchedAt: new Date(row.last_searched_at as string),
    }))
    .filter(isPublishable);
}
