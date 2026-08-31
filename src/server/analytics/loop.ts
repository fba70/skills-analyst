import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/server/db";
import { labelFor } from "@/server/taxonomy/vocabulary";

/**
 * Is the loop actually working? (Doc 2 R6.4)
 *
 * §2 says the loop is the product and §7.6 makes closing it a first-class requirement. Every
 * piece now exists — publish-back, creation telemetry, bounded consumption at mining time —
 * and none of that is worth anything if it quietly stops. R6.4 asks for the view that would
 * tell you: version history with evidence, the G3 and G4 trends, and **an alert when the
 * loop stalls**.
 *
 * ## The stall check is the part that earns its place
 *
 * A dashboard of green numbers is easy to build and easy to stop reading. The question worth
 * answering automatically is the one nobody thinks to ask: *signals are arriving and nothing
 * is learning from them.* That happens silently — mining is a manual command, so a category
 * can accumulate authoring signal for weeks while its archetype sits at the version it had
 * before anyone used the builder. Nothing errors. The corpus keeps growing. The loop is
 * simply open.
 *
 * ## Metrics are reported with their sample size, or not at all
 *
 * G3 asks for ≥80% first-pass validation and G4 for ≥60% of sessions using a corpus
 * suggestion. Both are shares, and a share over three drafts is not a trend — it is one
 * draft's opinion expressed as a percentage. Every figure here carries the count it came
 * from so a reader can tell a signal from an anecdote, and `MIN_SESSIONS_FOR_TREND` marks
 * the point below which the number should not be acted on.
 */

/** Below this many published drafts, G3 and G4 are reported but flagged as thin. */
export const MIN_SESSIONS_FOR_TREND = 10;

/** Signals piled up beyond this without a mine is a stall worth naming. */
export const STALL_SIGNAL_THRESHOLD = 20;

export type LoopMetrics = {
  /**
   * Authoring sessions that reached publication.
   *
   * There is deliberately **no "drafts written" figure**. `skill_drafts` holds the author's
   * purpose and their section notes — real tenant content — behind an org-scoped policy with
   * no `IS NULL` case, so an operator cannot read it and should not. `builder_signals` is
   * the opposite by construction: booleans and closed-vocabulary values, readable across
   * organisations precisely because it carries nothing private. Every number here comes from
   * the second table, which is why every number here is honest at this altitude.
   *
   * The first version of this panel counted drafts anyway and reported zero written against
   * one published — a nonsense that was really the isolation working.
   */
  sessions: number;
  /** G3: share of published drafts that passed validation on the first pass. */
  firstPassRate: number | null;
  /** G4: share that kept at least one archetype-suggested section. */
  suggestionUseRate: number | null;
  /** True when both shares rest on too few sessions to read as a trend. */
  thin: boolean;
};

export async function loopMetrics(): Promise<LoopMetrics> {
  /**
   * Counted per **draft**, not per signal.
   *
   * `builder_signals` holds one row per section, so a naive count would weight a draft with
   * eight sections eight times as heavily as one with three — turning a metric about
   * authoring sessions into a metric about document length.
   */
  const [row] = await db
    .select({
      published: sql<number>`(select count(distinct draft_id) from builder_signals)::int`,
      firstPass: sql<number>`(
        select count(distinct draft_id) from builder_signals where first_pass_valid
      )::int`,
      usedSuggestion: sql<number>`(
        select count(distinct draft_id) from builder_signals
        where survived and archetype_version is not null
      )::int`,
    })
    .from(sql`(select 1) as _`);

  const published = row?.published ?? 0;
  const share = (n: number) => (published > 0 ? Math.round((n / published) * 100) : null);

  return {
    sessions: published,
    firstPassRate: share(row?.firstPass ?? 0),
    suggestionUseRate: share(row?.usedSuggestion ?? 0),
    thin: published < MIN_SESSIONS_FOR_TREND,
  };
}

export type ArchetypeActivity = {
  category: string;
  label: string;
  version: number;
  changelog: string | null;
  minedAt: Date;
  /** Signals recorded for this category *since* that mine. The stall measure. */
  signalsSince: number;
  /** True when enough unconsumed signal has accumulated to be worth acting on. */
  stalled: boolean;
};

/**
 * Recent mines, and what has arrived since each one.
 *
 * `signalsSince` is the whole point. An archetype at v5 with two hundred signals recorded
 * after it was mined is not a healthy archetype — it is a stale one, and the only reason it
 * has not moved is that nobody ran the command. R6.4 wants that alert, and the number is
 * also the thing that tells an operator whether re-mining would change anything.
 */
export async function archetypeActivity(): Promise<ArchetypeActivity[]> {
  const result = await db.execute(sql`
    with latest as (
      select distinct on (category)
        category, version, changelog, created_at
      from archetypes
      where axis = 'function' and org_id is null
      order by category, version desc
    )
    select
      l.category,
      l.version,
      l.changelog,
      l.created_at,
      (
        select count(distinct s.draft_id)
        from builder_signals s
        where s.archetype_category = l.category
          and s.created_at > l.created_at
      )::int as signals_since
    from latest l
    order by signals_since desc, l.created_at desc
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    const signalsSince = Number(row.signals_since ?? 0);
    return {
      category: row.category as string,
      label: labelFor("function", row.category as string),
      version: Number(row.version),
      changelog: (row.changelog as string | null) ?? null,
      minedAt: new Date(row.created_at as string),
      signalsSince,
      stalled: signalsSince >= STALL_SIGNAL_THRESHOLD,
    };
  });
}

export type LoopEvent = {
  kind: string;
  reason: string | null;
  at: Date;
};

/**
 * The loop's own audit trail, newest first.
 *
 * Reads the events the loop writes — a draft refused, a skill published, an archetype
 * mined, a budget threshold crossed. R6.4 asks for "what changed and why"; these rows *are*
 * the why, already written by R7.1's auditing, so surfacing them costs one query rather
 * than a second bookkeeping system that could disagree with the first.
 */
export async function loopEvents(limit = 12): Promise<LoopEvent[]> {
  /**
   * Only the platform-scoped kinds, because those are the only ones an operator can see.
   *
   * `events` carries the standard org policy, so a row written against an organisation —
   * `builder.published` is one — is invisible to an unscoped query. Listing it here would
   * produce a feed that silently omits the most interesting event in the loop and looks
   * complete while doing it. A workspace's own publications are visible to that workspace.
   */
  const result = await db.execute(sql`
    select kind, reason, at
    from events
    where kind in ('builder.refused', 'builder.generated', 'archetype.mined')
      and org_id is null
    order by at desc
    limit ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    kind: row.kind as string,
    reason: (row.reason as string | null) ?? null,
    at: new Date(row.at as string),
  }));
}
