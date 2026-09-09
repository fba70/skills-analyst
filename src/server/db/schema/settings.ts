import { sql } from "drizzle-orm";
import {
  index,
  uniqueIndex,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { orgPlan } from "./enums";

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

/**
 * What an organisation is entitled to (Doc 2 RC.1).
 *
 * ## Its own table, not a column on `organization`
 *
 * The plan for this step said "a plan column on the organisation", and that was the wrong
 * call. `organization` is Better Auth's table: CLAUDE.md's standing rule is that those
 * shapes are re-derived with `getAuthTables()` whenever a plugin is added or the version
 * moves, and a hand-added column is precisely what that regeneration would not know about.
 * A commercial fact does not belong in an auth vendor's schema.
 *
 * It also buys room RC.4 will need — a billing customer id, a period end, a seat count —
 * none of which belong on an auth table either.
 *
 * ## An absent row means `free`
 *
 * Deliberate, and it is what makes the free-tier guarantee hold on a fresh deployment: the
 * table is empty, every lookup falls back to `free`, and nothing is gated. The alternative —
 * a row per organisation written at creation — would mean a bootstrap that failed halfway
 * left organisations with no plan at all, and "no plan" would have to mean something.
 *
 * ## One row per organisation
 *
 * `organizationId` is the primary key rather than a surrogate id with a unique index. There
 * is exactly one current entitlement per organisation and history lives in `events`, which
 * is the same split `platform_settings` uses: the row is the current answer, the log is how
 * it got there.
 */
export const orgEntitlements = pgTable(
  "org_entitlements",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    plan: orgPlan("plan").notNull().default("free"),
    /** Why, in the admin's words — a trial, a design partner, a downgrade. */
    note: text("note"),
    /** Who last set it. `events` carries the full history; this is the quick answer. */
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    /**
     * When the plan lapses back to free, if it is time-boxed.
     *
     * Read by the gate, so an expired trial stops granting without anyone running a job —
     * the same posture as the lifecycle's `review_by`. A plan with no end date does not
     * expire, which is the ordinary paid case.
     */
    validUntil: timestamp("valid_until", { withTimezone: true }),

    /**
     * The payment provider's customer id (RC.4, plan step F2).
     *
     * A5's own note said a billing customer id belongs here rather than on Better Auth's
     * `organization` table, and this is it. Nullable and unset for every workspace an admin
     * granted a plan to by hand, which is all of them today — a webhook for an unrecognised
     * customer is recorded as `unmapped` rather than guessed at.
     */
    billingCustomerId: text("billing_customer_id"),
    /** Which provider that id belongs to. Two providers would give one id two meanings. */
    billingProvider: text("billing_provider"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One workspace per billing customer, per provider.
     *
     * Without it a mis-typed link could point two workspaces at one customer, and a webhook would
     * then upgrade whichever the query happened to return first — a permissions-shaped bug wearing
     * a data-entry mistake's clothes. Partial, because almost every row is null today.
     */
    uniqueIndex("org_entitlements_billing_customer_uq")
      .on(t.billingProvider, t.billingCustomerId)
      .where(sql`${t.billingCustomerId} is not null`),

    /**
     * The schema's **third split policy**, and it is safe for the same reason as the other two.
     *
     * SELECT is open to `app_runtime`; INSERT and UPDATE are org-scoped. That split is
     * forced by two reads that are cross-organisation by definition:
     *
     *   - an operator listing every workspace's plan, which is the admin panel's whole job;
     *   - resolving the plan behind an MCP token, which happens *before* any organisation
     *       scope has been set — the same shape that made `mcp_tokens.SELECT` open, where
     *       looking the token up is how the organisation is discovered in the first place.
     *
     * It is safe **because of the column list**: a plan name, an admin's own note, who set
     * it and when it lapses. No tenant content, ever. `builder_signals` rests on exactly
     * this argument and its migration says the same thing — add a column carrying customer
     * data and this policy becomes wrong.
     *
     * Writes stay scoped, so one organisation can never grant itself another's plan.
     *
     * **No DELETE policy, deliberately.** A downgrade is `plan = 'free'`, which is a row an
     * auditor can see and an event that names who did it. Deleting the row would produce an
     * identical outcome with no trace — the absent-row-means-free default doing the work
     * silently. Same reasoning as `platform_settings`, where a delete would quietly restore
     * a default and the audit log would show nothing at all.
     */
    pgPolicy("read_all", {
      for: "select",
      to: "app_runtime",
      using: sql`true`,
    }),
    pgPolicy("org_write", {
      for: "insert",
      to: "app_runtime",
      withCheck: sql`organization_id = current_setting('app.org_id', true)`,
    }),
    pgPolicy("org_update", {
      for: "update",
      to: "app_runtime",
      using: sql`organization_id = current_setting('app.org_id', true)`,
      withCheck: sql`organization_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * Every webhook delivery, including the ones that changed nothing (Doc 2 RC.4, plan step F2).
 *
 * ## The idempotency key is a row, not a hope
 *
 * `(provider, event_id)` is unique, so a retry is an insert that conflicts rather than a second
 * plan change. Providers retry until they get a 2xx, so duplicates are the **normal** case — a
 * design that treats them as a fault would treat most of its traffic as a fault.
 *
 * ## Refusals are rows too, and that is the point
 *
 * `stale`, `unmapped`, `ignored` and `invalid` are all recorded. A webhook endpoint that only
 * writes when it succeeds is one where *"we never got the event"* and *"we got it and did
 * nothing"* look identical from the outside — the same distinction the heartbeat exists to draw
 * between a run that is slow and a run that is stuck.
 *
 * ## No column holds the payload
 *
 * A subscription body carries names, email addresses and card metadata. What is kept is the
 * event id, its type, its timestamp, the customer id and what we decided — enough to answer
 * *"why is this workspace on this plan"* and not enough to be a copy of somebody's billing
 * record. Same safe-because-of-the-column-list argument as `mcp_usage`.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    provider: text("provider").notNull(),
    /** The provider's own event id. Half the idempotency key. */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),

    /**
     * The provider's timestamp, not ours.
     *
     * Ordering has to be decided by when the event *happened*, because the whole failure this
     * guards against is deliveries arriving in a different order from the one they occurred in.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    customerId: text("customer_id"),
    /** Null when no workspace is linked to that customer — the `unmapped` outcome. */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),

    /** One of `WEBHOOK_OUTCOMES`. */
    outcome: text("outcome").notNull(),
    /** The plan it set, when it set one. */
    appliedPlan: text("applied_plan"),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The idempotency key. A retry conflicts here rather than changing a plan twice. */
    uniqueIndex("billing_events_uq").on(t.provider, t.eventId),
    /** The ordering check: the newest applied change for one workspace. */
    index("billing_events_org_idx").on(t.organizationId, t.occurredAt),

    /**
     * Open to `app_runtime`, because this is an operator record with no tenant reader.
     *
     * Safe because of the column list — an event id, a type, two timestamps, a customer id and a
     * decision. A workspace never reads it; the Plans panel does, across all of them. Add a
     * column carrying the payload and this policy becomes wrong.
     */
    pgPolicy("all_access", {
      for: "all",
      to: "app_runtime",
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);
