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
