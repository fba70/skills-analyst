import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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

/**
 * Rate-limit counters (Doc 2 R8.8).
 *
 * ## Postgres, not Redis, and the trade is stated rather than hidden
 *
 * There is no Redis in this stack, and adding one to count requests would be new
 * infrastructure to operate for a table with two integer columns. The cost is a round trip
 * per call and a write on every request — real, and acceptable at a volume where the thing
 * being protected is *also* a database query. If MCP traffic ever outgrows this, the fix is
 * a cache in front, not a different schema.
 *
 * ## One row per identity per bucket, not one row per window
 *
 * A row per window is the obvious design and it grows without bound: every minute mints a
 * new row for every caller, and nothing ever reads the old ones again. Here the row carries
 * its own `windowStart` and the upsert resets the count when the window has rolled, so the
 * table holds one row per caller per bucket for as long as that caller keeps calling.
 *
 * The consequence is a **fixed window**, which permits a burst of up to twice the limit
 * across a boundary — 60 calls at 11:59:59 and 60 more at 12:00:00. A sliding window would
 * not, at the cost of keeping two counters and interpolating. For a first limit whose job is
 * stopping a runaway agent loop rather than resisting a determined attacker, the simpler
 * one is the right trade, and saying so here is better than someone rediscovering it from a
 * graph.
 *
 * ## Why DELETE is permitted here and nowhere else
 *
 * `platform_settings` and `llm_usage` withhold DELETE because they are records of decisions
 * and charges — an application that can erase its own audit trail has none. These are
 * neither. A counter is ephemeral operational state whose whole purpose expires with its
 * window, and pruning callers that have gone away is maintenance rather than history loss.
 * The audit trail for rate limiting lives in `events`, where the *policy* changes are.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    /** Who is being counted — `ip:1.2.3.4` today, a token or org id once RC.1 exists. */
    bucketKey: text("bucket_key").notNull(),
    /** What is being counted, e.g. `mcp_free:minute`. Bucket width is part of the scope. */
    scope: text("scope").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bucketKey, t.scope] }),
    /** For pruning callers that stopped calling; never read on the request path. */
    index("rate_limit_buckets_window_idx").on(t.windowStart),
  ],
);

/**
 * Where the pipeline is, right now (one row, updated in place).
 *
 * ## The gap this closes
 *
 * A pass writes its `events` row when it **finishes**. So a pass that never finishes writes
 * nothing at all, and from outside "working on a 6,000-skill repository" and "hung on a dead
 * socket" look identical: no new events, no new versions for a while, a process that is
 * alive. That ambiguity cost hours on three separate occasions, each diagnosed by hand with
 * `ps` and `lsof` — which is not a thing anyone should need to do to answer "is it stuck".
 *
 * A completion record cannot answer that question by construction. Only a *progress* record
 * can, so this is written **during** a stage rather than after it.
 *
 * ## One row, updated in place — deliberately not events
 *
 * `events` is append-only and is the audit trail; a beat every fifteen seconds for a
 * multi-hour run would add tens of thousands of rows that no audit would ever want, and bury
 * the transitions that matter. This is ephemeral operational state: it has no history worth
 * keeping, because the only interesting question is *how old is it*.
 *
 * The primary key is a constant, so the table cannot grow a second row however many
 * processes write to it. Two pipelines running at once is itself a mistake, and a heartbeat
 * that silently interleaved them would hide it — the last writer wins and the `pid` says who.
 */
export const pipelineHeartbeat = pgTable("pipeline_heartbeat", {
  /** Always `singleton`. A one-row table by construction rather than by convention. */
  id: text("id").primaryKey().default("singleton"),
  /** `sync`, `validate`, … — which stage is running. */
  stage: text("stage"),
  /** A human sentence: "infometa/workbuddyskills — 436/2355 skills". */
  detail: text("detail"),
  itemsDone: integer("items_done"),
  itemsTotal: integer("items_total"),
  /** When the current pass began, so a slow pass is distinguishable from a stalled one. */
  passStartedAt: timestamp("pass_started_at", { withTimezone: true }),
  /** The beat itself. **This is the number that answers "is it stuck".** */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Which process, so two concurrent runs are visible rather than confusing. */
  pid: integer("pid"),
});
