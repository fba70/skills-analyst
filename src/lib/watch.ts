/**
 * Notifications (Doc 2 R8.7, plan step F5) — the last step of the plan.
 *
 * *"Watch a skill or a category; be told when a version changes, a takedown lands or a lifecycle
 * state moves."* The plan's own note is the design: **every one of those already exists as an
 * `events` row**, so this is not an event system. It is a subscription, a query and a surface.
 *
 * ## Derived on read, with no fan-out job
 *
 * The obvious build materialises a notification row per watcher per event, behind a cursor job.
 * That is a job that can fail silently, a dedup rule, and a second copy of something `events`
 * already holds — three of this codebase's recorded failure shapes in one feature.
 *
 * Instead a watch stores **what you watch and when you last looked**, and the feed is a query
 * over `events` since that timestamp. Correct by construction, nothing to re-run, and a watch
 * added today can show yesterday's history because the events were never the missing part.
 *
 * The cost is a query per watcher per read rather than a write per watcher per event, which is
 * the right way round: `events_subject_idx` already indexes `(subject_type, subject_id, at)`, and
 * there are far more events than there are people looking at them.
 *
 * ## The events name a *version*, and that is the whole difficulty
 *
 * Measured against the live table: `skill_version.indexed` is 108,074 rows, `skill_version.created`
 * 51,207, `skill_version.quarantined` 2,804 — and every one of them carries a **version id** in
 * `subject_id`. A watcher watches a *skill*. So the feed cannot match on subject alone; it
 * resolves versions back to their skill.
 *
 * And one kind spells its subject type differently. `licence.reresolved` was written
 * `skill_version`, singular, against `skill_versions` everywhere else — 404 rows. A feed matching
 * one spelling drops them silently, and a licence re-resolution is precisely what a watcher of
 * that skill wants to hear about: it is the event that turns an undownloadable skill into a
 * downloadable one. Fixed forward in `sync.ts`; both spellings are accepted here for the history.
 */

export const WATCH_SUBJECTS = ["skill", "category"] as const;

export type WatchSubject = (typeof WATCH_SUBJECTS)[number];

export function isWatchSubject(value: unknown): value is WatchSubject {
  return typeof value === "string" && (WATCH_SUBJECTS as readonly string[]).includes(value);
}

/**
 * The subject types on `events` that mean "a version of a skill".
 *
 * Two spellings, because 404 historical rows use the singular. Derived into the query rather than
 * typed out at the call site, so the next reader does not have to rediscover why there are two.
 */
export const VERSION_SUBJECT_TYPES = ["skill_versions", "skill_version"] as const;

/**
 * What a watcher is told about, and what they are deliberately not.
 *
 * An allow-list rather than everything on the subject. `events` carries operational rows —
 * `structures.extracted`, `taxonomy.classified`, `skill_version.created` — that are true, are
 * about this skill, and are noise to somebody who wanted to know whether it still works. A feed
 * that reports every derived-data pass is one people stop reading, and then the takedown in
 * amongst it is missed.
 *
 * `skill_version.created` is the sharpest case and is **excluded**: it fires when bytes change
 * upstream, before validation has decided anything. `indexed` and `quarantined` are the answers.
 */
export const NOTIFIABLE_KINDS: Record<string, { label: string; tone: "good" | "bad" | "neutral" }> = {
  "skill_version.indexed": { label: "A new version passed validation", tone: "good" },
  "skill_version.quarantined": { label: "A new version was quarantined", tone: "bad" },
  "skill_version.tombstoned": { label: "Removed upstream", tone: "bad" },
  "licence.reresolved": { label: "The licence was re-resolved", tone: "neutral" },
  "skill.clustered_as_variant": { label: "Folded under another entry as a near-duplicate", tone: "neutral" },
  "lifecycle.declared": { label: "A curator changed its lifecycle", tone: "neutral" },
  "lifecycle.cleared": { label: "A lifecycle declaration was lifted", tone: "neutral" },
  "skill.endorsed": { label: "A maintainer endorsed it", tone: "good" },
  "flag.upheld": { label: "A reader's report was upheld", tone: "bad" },
  "builder.published": { label: "Published from the builder", tone: "good" },
};

export function isNotifiable(kind: string): boolean {
  return Object.hasOwn(NOTIFIABLE_KINDS, kind);
}

export function notificationLabel(kind: string): string {
  return NOTIFIABLE_KINDS[kind]?.label ?? kind;
}

/**
 * How far back a new watch can see.
 *
 * A watch created today shows the last month, because the events were always there and hiding
 * them would be pretending the feature only started working when you pressed the button. Bounded
 * so the first read of a new watch is not a scan of 185,000 rows.
 */
export const WATCH_BACKFILL_DAYS = 30;

/** The most a feed returns in one read. A page, not a history. */
export const FEED_LIMIT = 100;

/**
 * A category watch is `axis:value`, the same shape the registry filter uses.
 *
 * One encoding for one idea, so a watch on `function:review` and the URL that lists those skills
 * agree by construction — the `labelFor` split is what happens when they do not.
 */
export function categoryKey(axis: string, value: string): string {
  return `${axis}:${value}`;
}

export function parseCategoryKey(key: string): { axis: string; value: string } | null {
  const [axis, ...rest] = key.split(":");
  const value = rest.join(":");
  if (!axis || !value) return null;
  if (axis !== "function" && axis !== "domain") return null;
  return { axis, value };
}
