import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills, skillVersions } from "./corpus";

/**
 * External links, and whether they still resolve (Doc 6 RK.2, plan step E1).
 *
 * ## A state table, not a log — and this repo defaults the other way
 *
 * `verdicts`, `eval_runs`, `draft_revisions` and `llm_usage` are all append-only, because each
 * row is evidence about a moment. A link check is not: its entire value is *is this broken right
 * now*, and a log would grow by URL times check forever to answer a question only the newest row
 * ever answers.
 *
 * What history *is* worth keeping is the part that distinguishes rot from a blip, so the row
 * carries `consecutive_failures` and `first_failed_at` rather than the runs that produced them.
 * Two numbers instead of a table, and they are the two the rot rule reads.
 *
 * ## Keyed on the version, not the skill
 *
 * A link belongs to a document. Re-sync produces a new version with possibly different links, and
 * keying on the skill would carry a dead URL forward onto a document that no longer contains it —
 * the "recorded then ignored" shape, pointed at a reader this time.
 */
export const linkChecks = pgTable(
  "link_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Mirrors the version's tenancy so the policy needs no join. Null is the public corpus. */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    url: text("url").notNull(),

    /** One of `LINK_STATUSES`. Only `broken` ever counts as rot — see `classifyLink`. */
    status: text("status").notNull(),
    /** What the server said, or null when the request never completed. */
    statusCode: smallint("status_code"),

    /**
     * Consecutive failing checks, and when the run began.
     *
     * The pair is the whole reason this is not a boolean: one failed fetch is a deploy, a rate
     * limit or a flaky edge, and reporting it as rot would make the panel unreadable inside a
     * week. Reset to zero the moment a check succeeds, so a link that recovered stops accusing.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),

    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One row per link per document. The upsert target, and the reason this is a state table. */
    uniqueIndex("link_checks_uq").on(t.skillVersionId, t.url),
    /** The panel's query: everything currently rotten, newest first. */
    index("link_checks_status_idx").on(t.status, t.consecutiveFailures),
    /** The scheduler's query: what has not been looked at recently. */
    index("link_checks_due_idx").on(t.checkedAt),

    /**
     * `org_id IS NULL` is the public corpus, which is every link the crawl produces. The clause
     * is what keeps a Team-tier private skill's links inside its own tenant when R1.9 lands —
     * and a URL is exactly the kind of thing that would leak a customer's internal hostnames.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * The latest released version of each thing skills pin (Doc 7 RD.10, plan step P5).
 *
 * ## A state table, not a log — and for the reason `link_checks` is one
 *
 * The entire value of a row is *what is current now*. A history keyed by check would grow by
 * project × pass to answer a question only the newest row answers, and the two numbers worth
 * keeping from the past — the failure streak and when it started — are columns.
 *
 * ## One row per tracked project, not per skill
 *
 * Twenty projects against seven thousand documents that pin something. The drift a reader sees
 * is **derived on read** by comparing a skill's stored `version_pins` against this table, so
 * nothing has to be recomputed when a release ships: one row changes and every document that
 * names it reads differently. The same reason the lifecycle is a derivation rather than a
 * column, and the reason RK.4's transclusion state is not stored either.
 *
 * `org_id` is deliberately absent: what Node released is not a fact about anybody's workspace.
 * That makes this the rare table with no tenant column, which is safe **because of the column
 * list** — a project name, a version string, a date and a status. It may never grow a column
 * that names a skill, an organisation or a URL a customer supplied.
 */
export const toolVersions = pgTable(
  "tool_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** One of `VERSIONED_IDS`. A closed vocabulary, which is what makes the join sound. */
    subject: text("subject").notNull(),
    /** The latest released version as the feed reports it, or NULL when nothing answered. */
    currentVersion: text("current_version"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /** `ok` | `blocked` | `unreachable` — the same three a link check distinguishes. */
    status: text("status").notNull(),
    statusCode: integer("status_code"),
    /**
     * Kept for the same reason `link_checks` keeps it: one refusal is a fact about a bad
     * afternoon, and a run of them is a fact about the feed. A single failure must never
     * discard a version we already know.
     */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tool_versions_uq").on(t.subject),
    index("tool_versions_due_idx").on(t.checkedAt),
    /**
     * Readable by everyone, writable by the app.
     *
     * There is no tenant dimension to scope on — a release date is a fact about the world —
     * and the drift it feeds is shown on public skill pages, so an org-scoped read would make
     * the feature invisible to exactly the anonymous reader R8.1 exists for.
     */
    pgPolicy("public_read", {
      for: "all",
      to: "app_runtime",
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);
