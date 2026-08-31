import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";

/**
 * Operational policy, as data (Doc 3, and the standing note in CLAUDE.md).
 *
 * The first instalment of a migration this codebase has been anticipating: every decision
 * about *what gets fetched and how often* lives in `crawl/policy.ts` and in constants inside
 * the cron route, where changing one means a redeploy. Doc 3 makes the argument for sync
 * cadence — "cadence is data, not deploys" — and it applies to every knob an operator tunes
 * against a live corpus, because tuning through a deploy is too slow to learn anything.
 *
 * ## Key/value, not a column per setting
 *
 * A typed column per knob would be tidier and would need a migration every time a knob is
 * added — which is the cost that keeps knobs in code. The value is `jsonb` with a
 * TypeScript shape and a **documented default** in `settings/schedule.ts`, so a missing row
 * means "the default", not "undefined". That matters more than it sounds: the table is
 * empty on a fresh deployment, and a scheduler that reads an absent row as `enabled: true`
 * would start fetching before anyone had configured it.
 *
 * ## Not org-scoped
 *
 * These are platform settings. There is deliberately no `org_id`: a customer does not
 * configure our ingest cadence, and adding the column would invite a policy question
 * nobody has asked. When per-org policy exists it should be a different table with a
 * different access rule, not a nullable column here.
 */
export const platformSettings = pgTable("platform_settings", {
  /** Dotted, e.g. `schedule.pipeline`. Stable — it is the contract with the reader. */
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default(sql`'{}'::jsonb`),

  /** Who changed it. Every write also lands in `events` (R7.1); this is the quick answer. */
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
