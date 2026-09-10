import "dotenv/config";

import { Client } from "pg";

import {
  categoryKey,
  FEED_LIMIT,
  isNotifiable,
  isWatchSubject,
  NOTIFIABLE_KINDS,
  parseCategoryKey,
  VERSION_SUBJECT_TYPES,
  WATCH_BACKFILL_DAYS,
} from "../src/lib/watch";

/**
 * A watcher is told what changed, and not told about the plumbing (Doc 2 R8.7, plan step F5).
 *
 *   pnpm verify:watch
 *
 * Free. It writes a real watch through the real function and removes it in a `finally`.
 *
 * ## The property this file exists to protect
 *
 * **The feed must actually return the events.** Every kind that matters carries a *version* id in
 * `subject_id` — `skill_version.indexed` alone is 108,074 rows — while a watcher names a *skill*.
 * A feed matching the subject directly would return almost nothing and look like a working
 * feature over a quiet corpus, which is the failure mode this codebase keeps finding: a confident
 * empty answer.
 *
 * So the suite finds a skill that genuinely has notifiable history, watches it, and requires the
 * feed to be non-empty. A fixture with no events could not tell a working join from a broken one.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nWhat a watcher is told, and what they are spared");

check(
  "the notifiable kinds are an allow-list, not everything on the subject",
  Object.keys(NOTIFIABLE_KINDS).length > 0 && Object.keys(NOTIFIABLE_KINDS).length < 20,
  `${Object.keys(NOTIFIABLE_KINDS).length} kinds`,
);
/*
 * The three loudest kinds in the table, and all three are noise to a watcher.
 *
 * `skill_version.created` fires when bytes change upstream, *before* validation has decided
 * anything — `indexed` and `quarantined` are the answers, and reporting the question as well
 * doubles the feed. The other two are derived-data passes. A feed that reports every one of these
 * is one people mute, and then the takedown in amongst it is missed.
 */
for (const noisy of ["skill_version.created", "structures.extracted", "taxonomy.classified"]) {
  check(`${noisy} is not notifiable`, !isNotifiable(noisy));
}
check(
  "but a quarantine is",
  isNotifiable("skill_version.quarantined") && isNotifiable("skill_version.indexed"),
);
check(
  "every kind has a label a person can read, and a tone",
  Object.values(NOTIFIABLE_KINDS).every(
    (meta) => meta.label.length > 0 && ["good", "bad", "neutral"].includes(meta.tone),
  ),
);
check(
  "both spellings of the version subject type are accepted",
  VERSION_SUBJECT_TYPES.includes("skill_versions") && VERSION_SUBJECT_TYPES.includes("skill_version"),
  "404 historical licence.reresolved rows use the singular; dropping them would hide the one event that makes a skill downloadable",
);

console.info("\nThe vocabulary");

check("an unknown subject is refused", !isWatchSubject("source"));
check(
  "a category key round-trips",
  parseCategoryKey(categoryKey("function", "review"))?.value === "review",
);
check(
  "and an invented axis is refused",
  parseCategoryKey("axis:review") === null && parseCategoryKey("review") === null,
);
check(
  "a new watch sees recent history rather than nothing",
  WATCH_BACKFILL_DAYS > 0 && WATCH_BACKFILL_DAYS <= 90,
  `${WATCH_BACKFILL_DAYS} days — a feed that is empty the day you subscribe teaches people it does not work`,
);
check("the feed is a page, not a history", FEED_LIMIT > 0 && FEED_LIMIT <= 200, `${FEED_LIMIT}`);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.skill_watches') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — the migration is not applied yet");
  } else {
    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'skill_watches'`,
    );
    check(
      "there is no notification table — a watch is a watermark",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from information_schema.tables where table_name = 'notifications'`,
        )
      ).rows[0].n === "0",
      "a materialised row per watcher per event needs a fan-out job that can fail silently",
    );
    check(
      "read state is one timestamp, not per-item flags",
      columns.some((col) => col.column_name === "last_seen_at") &&
        !columns.some((col) => col.column_name === "read_at"),
    );

    /*
     * A skill with real notifiable history, because a fixture with none cannot tell a working
     * join from a broken one — and the join is the whole difficulty of this step.
     */
    const { rows: candidate } = await c.query<{ id: string; slug: string; n: number }>(`
      select s.id, s.slug, count(*)::int as n
        from events e
        join skill_versions v on v.id::text = e.subject_id
        join skills s on s.id = v.skill_id
       where e.kind in ('skill_version.indexed','skill_version.quarantined','licence.reresolved')
         and s.org_id is null
       group by s.id, s.slug
      having count(*) > 1
       limit 1
    `);
    const { rows: who } = await c.query<{ id: string }>(
      `select id from "user" order by created_at limit 1`,
    );

    if (candidate.length === 0 || who.length === 0) {
      console.info("  skip  needs one account and one skill with notifiable history");
    } else {
      const userId = who[0].id;
      const { watch, unwatch, isWatching, feed, markSeen, unreadCount } = await import(
        "../src/server/notifications/watch"
      );

      try {
        const started = await watch({ userId, subjectType: "skill", subjectId: candidate[0].id });
        check("a skill can be watched", started.ok);
        check("and the watch reads back", await isWatching(userId, "skill", candidate[0].id));

        await watch({ userId, subjectType: "skill", subjectId: candidate[0].id });
        const { rows: once } = await c.query<{ n: string }>(
          `select count(*)::text as n from skill_watches where user_id = $1 and subject_id = $2`,
          [userId, candidate[0].id],
        );
        check(
          "watching twice is one subscription",
          once[0].n === "1",
          "pressing the button again is not a second watch",
        );

        /*
         * The headline. The events are on versions and the watch is on a skill; if the join is
         * wrong this comes back empty and everything else still passes.
         */
        const items = await feed(userId);
        check(
          "the feed resolves version events back to the watched skill",
          items.length > 0,
          `${items.length} item(s) — a subject-only match would have returned none`,
        );
        check(
          "every item carries a readable label rather than a raw kind",
          items.every((item) => item.label !== item.kind || !isNotifiable(item.kind)),
        );
        check(
          "and only notifiable kinds appear",
          items.every((item) => isNotifiable(item.kind)),
          "no derived-data passes in a feed a person reads",
        );

        const before = await unreadCount(userId);
        await markSeen(userId);
        const after = await unreadCount(userId);
        check(
          "marking seen moves the watermark and empties the feed",
          before > 0 && after === 0,
          `${before} → ${after}`,
        );

        const stopped = await unwatch({ userId, subjectType: "skill", subjectId: candidate[0].id });
        check("unwatching removes it", stopped.ok);
        check("and it stops reading back", !(await isWatching(userId, "skill", candidate[0].id)));
      } finally {
        await c.query(`delete from skill_watches where user_id = $1`, [who[0].id]);
        const { rows: left } = await c.query<{ n: string }>(
          `select count(*)::text as n from skill_watches where user_id = $1`,
          [who[0].id],
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
