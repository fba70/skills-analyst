import "server-only";

import { and, eq, sql } from "drizzle-orm";

import {
  categoryKey,
  FEED_LIMIT,
  isNotifiable,
  isWatchSubject,
  NOTIFIABLE_KINDS,
  parseCategoryKey,
  VERSION_SUBJECT_TYPES,
  WATCH_BACKFILL_DAYS,
  type WatchSubject,
} from "@/lib/watch";
import { db } from "@/server/db";
import { skillWatches } from "@/server/db/schema";

/**
 * Watching a skill or a category (Doc 2 R8.7, plan step F5).
 *
 * The reasoning is in `src/lib/watch.ts`. The one sentence worth repeating: **there is no
 * notification table and no fan-out job.** A watch records what you follow and when you last
 * looked; the feed is a query over the `events` rows that already exist.
 */

const NOTIFIABLE = Object.keys(NOTIFIABLE_KINDS);

export type WatchRow = {
  subjectType: WatchSubject;
  subjectId: string;
  label: string;
  lastSeenAt: Date;
  unread: number;
};

export type FeedItem = {
  at: Date;
  kind: string;
  label: string;
  tone: "good" | "bad" | "neutral";
  slug: string;
  name: string;
  reason: string | null;
  unread: boolean;
};

/**
 * The events for one watch, newest first.
 *
 * ## An event names a version and a watcher names a skill
 *
 * Measured on the live table: the kinds that matter carry a **version id** in `subject_id` —
 * `skill_version.indexed` alone is 108,074 rows. A feed matching `subject_id = <skill>` would
 * return almost nothing and look like a working feature with a quiet corpus.
 *
 * So events resolve to a skill by either path: the subject is the skill, or the subject is one of
 * its versions. And the version path accepts **both spellings** of the subject type, because 404
 * historical `licence.reresolved` rows say `skill_version` where everything else says
 * `skill_versions` — dropping those would silently hide the one event that turns an
 * undownloadable skill into a downloadable one.
 */
async function feedFor(
  subjectType: WatchSubject,
  subjectId: string,
  since: Date,
  limit: number,
): Promise<FeedItem[]> {
  /*
   * Two queries, not one join with an `or`, and the first version proved why.
   *
   * The obvious shape is `join skills s on (subject is the skill) or (subject is one of its
   * versions)`. Postgres cannot use an index for either branch of an `or` across two different
   * join conditions, so it degrades to a scan over 185,000 events against 50,000 skills — the
   * probe did not finish. Same class as E2's accidental cross-product, found the same way: by
   * running it rather than by reading it.
   *
   * The rewrite is not one clever query. It is **two shapes, because the two watches want
   * opposite drivers**:
   *
   *   - a **skill** watch knows its subject, so it drives from `events_subject_idx` — point
   *     lookups on the skill id and on its handful of version ids;
   *   - a **category** watch has thousands of skills and no useful subject list, so it drives
   *     from `events_at_idx` — the window since you last looked is small, and filtering it is
   *     cheap where enumerating the category is not.
   */
  return subjectType === "skill"
    ? feedForSkill(subjectId, since, limit)
    : feedForCategory(subjectId, since, limit);
}

/** Driven from the subject index: this skill, and the versions belonging to it. */
async function feedForSkill(
  skillId: string,
  since: Date,
  limit: number,
): Promise<FeedItem[]> {
  const { rows } = await db.execute<FeedRow>(sql`
    with mine as (
      select id::text as id from skill_versions where skill_id = ${skillId}::uuid
      union all
      select ${skillId}::text
    )
    select e.at, e.kind, s.slug, s.name, e.reason
      from events e
      join mine on mine.id = e.subject_id
      join skills s on s.id = ${skillId}::uuid
     where e.kind in (${kinds()})
       and e.at > ${since}
     order by e.at desc
     limit ${limit}
  `);
  return rows.map(toItem);
}

/**
 * Driven from time: the recent window, then filtered to the category.
 *
 * The servable-category rule the registry applies, not every assignment — a held assignment is
 * one the classifier itself called unreliable, and notifying somebody about a skill that is only
 * maybe in their category is how a feed earns a mute.
 */
async function feedForCategory(
  key: string,
  since: Date,
  limit: number,
): Promise<FeedItem[]> {
  const parsed = parseCategoryKey(key);
  if (!parsed) return [];

  const { rows } = await db.execute<FeedRow>(sql`
    select e.at, e.kind, s.slug, s.name, e.reason
      from events e
      join skill_versions v on v.id::text = e.subject_id
      join skills s on s.id = v.skill_id
     where e.at > ${since}
       and e.kind in (${kinds()})
       and e.subject_type in (${sql.join(
         VERSION_SUBJECT_TYPES.map((type) => sql`${type}`),
         sql`, `,
       )})
       and s.org_id is null
       and exists (
         select 1 from skill_categories sc
          where sc.skill_id = s.id
            and sc.axis = ${parsed.axis}
            and sc.value = ${parsed.value}
            and (sc.confidence >= 60 or sc.reviewed_at is not null)
       )
     order by e.at desc
     limit ${limit}
  `);
  return rows.map(toItem);
}

/**
 * What the driver actually returns, which is not what a `sql<T>` annotation claims.
 *
 * `at` is a **string**. `db.execute` with a raw template applies no parser, so annotating the
 * column `Date` is a claim rather than a conversion — and the caller then calls `.toISOString()`
 * on a string and dies. E1's `linkCheckSummary` did exactly this with `min(checked_at)` and
 * CLAUDE.md records it; this is the same mistake in the same codebase, caught the same way, by
 * running it.
 *
 * Typed honestly here and converted once in `toItem`, so everything downstream has a real Date.
 */
type FeedRow = { at: string; kind: string; slug: string; name: string; reason: string | null };

/** The notifiable kinds, as a SQL list. One definition, from the leaf module. */
function kinds() {
  return sql.join(
    NOTIFIABLE.map((kind) => sql`${kind}`),
    sql`, `,
  );
}

function toItem(row: FeedRow): FeedItem {
  return {
    /* The one conversion, at the boundary where the driver's string becomes a Date. */
    at: new Date(row.at),
    kind: row.kind,
    label: NOTIFIABLE_KINDS[row.kind]?.label ?? row.kind,
    tone: NOTIFIABLE_KINDS[row.kind]?.tone ?? "neutral",
    slug: row.slug,
    name: row.name,
    reason: row.reason,
    /* Everything a feed read returns is by definition since the last look. */
    unread: true,
  };
}

/** Start watching. Idempotent — pressing the button twice is not two subscriptions. */
export async function watch(input: {
  userId: string;
  subjectType: string;
  subjectId: string;
}): Promise<{ ok: boolean; message: string }> {
  if (!isWatchSubject(input.subjectType)) return { ok: false, message: "Unknown subject." };
  if (input.subjectType === "category" && !parseCategoryKey(input.subjectId)) {
    return { ok: false, message: "A category watch is `axis:value`." };
  }

  /*
   * The backfill window, applied at subscribe time.
   *
   * A feed that is empty on the day you press the button teaches people it does not work — and
   * the events were always there, so hiding them would be pretending the feature only started
   * when you subscribed. Bounded, so the first read is not a scan of 185,000 rows.
   */
  const since = new Date(Date.now() - WATCH_BACKFILL_DAYS * 24 * 60 * 60 * 1000);

  await db
    .insert(skillWatches)
    .values({
      userId: input.userId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      lastSeenAt: since,
    })
    .onConflictDoNothing({
      target: [skillWatches.userId, skillWatches.subjectType, skillWatches.subjectId],
    });

  return { ok: true, message: "Watching." };
}

export async function unwatch(input: {
  userId: string;
  subjectType: string;
  subjectId: string;
}): Promise<{ ok: boolean; message: string }> {
  await db
    .delete(skillWatches)
    .where(
      and(
        eq(skillWatches.userId, input.userId),
        eq(skillWatches.subjectType, input.subjectType),
        eq(skillWatches.subjectId, input.subjectId),
      ),
    );
  return { ok: true, message: "No longer watching." };
}

export async function isWatching(
  userId: string,
  subjectType: WatchSubject,
  subjectId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: skillWatches.id })
    .from(skillWatches)
    .where(
      and(
        eq(skillWatches.userId, userId),
        eq(skillWatches.subjectType, subjectType),
        eq(skillWatches.subjectId, subjectId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Everything one person watches, with how much is waiting on each. */
export async function watchList(userId: string): Promise<WatchRow[]> {
  const rows = await db
    .select()
    .from(skillWatches)
    .where(eq(skillWatches.userId, userId))
    .orderBy(skillWatches.createdAt);

  const out: WatchRow[] = [];
  for (const row of rows) {
    if (!isWatchSubject(row.subjectType)) continue;
    const items = await feedFor(row.subjectType, row.subjectId, row.lastSeenAt, FEED_LIMIT);
    out.push({
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      label: row.subjectId,
      lastSeenAt: row.lastSeenAt,
      unread: items.length,
    });
  }
  return out;
}

/** The combined feed across every watch, newest first. */
export async function feed(userId: string, limit = FEED_LIMIT): Promise<FeedItem[]> {
  const rows = await db
    .select()
    .from(skillWatches)
    .where(eq(skillWatches.userId, userId));

  const all: FeedItem[] = [];
  for (const row of rows) {
    if (!isWatchSubject(row.subjectType)) continue;
    all.push(...(await feedFor(row.subjectType, row.subjectId, row.lastSeenAt, limit)));
  }

  /*
   * De-duplicated across watches before sorting.
   *
   * One event can match several watches — a skill you follow that is also in a category you
   * follow — and reporting it twice would make the count wrong and the feed look padded. The key
   * is the event's own identity: one moment, one skill, one kind.
   */
  const seen = new Set<string>();
  return all
    .filter((item) => {
      const key = `${item.at.toISOString()}:${item.slug}:${item.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit);
}

/** How many events are waiting, across everything this person watches. */
export async function unreadCount(userId: string): Promise<number> {
  return (await feed(userId, FEED_LIMIT)).length;
}

/**
 * Mark everything read, by moving the watermark.
 *
 * One column, no per-item state. A notification is not a thing here — it is an event you have or
 * have not caught up with — so "read" is a timestamp and there is nothing to fall out of step
 * with anything else.
 */
export async function markSeen(userId: string): Promise<void> {
  await db
    .update(skillWatches)
    .set({ lastSeenAt: new Date() })
    .where(eq(skillWatches.userId, userId));
}

/** Exported for the suite: the kinds a watcher is told about, and the ones deliberately not. */
export const NOTIFIABLE_KIND_LIST = NOTIFIABLE;
export { categoryKey, isNotifiable };
