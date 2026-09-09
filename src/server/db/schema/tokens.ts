import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";

/**
 * MCP access tokens (Doc 2 R8.8).
 *
 * ## Ours, not Better Auth's
 *
 * Better Auth 1.7.2 ships no API-key plugin, and the version is pinned deliberately — core
 * and plugins must move together or two copies of `@better-auth/core` crash at startup. So
 * this is a small table of our own, which is the better answer anyway: an MCP token must
 * **not** be a session. A leaked session is an account; a leaked token here reads the public
 * corpus through a rate-limited endpoint and can be revoked without signing anybody out.
 *
 * ## Only the hash is stored
 *
 * The token is shown once, at creation, and never again — we keep `sha256(token)` and an
 * eight-character prefix. The prefix is what the UI lists, so an operator can tell two
 * tokens apart without the table holding anything that could be replayed. A token column we
 * could read back would make this table worth stealing.
 *
 * ## Revoked, never deleted
 *
 * `revokedAt` is set; the row stays. A deleted row frees its name for silent re-creation and
 * erases the fact that a credential once existed — which is the question actually asked
 * after an incident. Same reasoning as `platform_settings` having no DELETE.
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * NOT NULL, unlike the corpus tables. There is no such thing as a public token: a
     * credential with no owner is one nobody can revoke and nobody is accountable for.
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Who created it. Kept when the user is deleted so the audit trail survives them. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** The operator's own label, e.g. "laptop", "ci". Not unique — people reuse names. */
    name: text("name").notNull(),
    /** `sha256(token)`, hex. The only copy of the secret that exists after creation. */
    tokenHash: text("token_hash").notNull(),
    /** First eight characters, for display. Never enough to authenticate with. */
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Best-effort, and deliberately not written on every call: one extra write per request
     * on the hot path to power a column nobody reads in real time is a poor trade. The
     * limiter's counters already show live traffic; this answers "is this token still used".
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mcp_tokens_hash_uq").on(t.tokenHash),
    index("mcp_tokens_org_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * What an MCP token actually did (Doc 2 RC.3, plan step F1).
 *
 * Every *model* call has been metered in `llm_usage` since RC.2, and MCP makes no model calls —
 * so the spend ledger was never going to answer this. The only records were a fixed window that
 * resets and a `last_used_at` that overwrites, neither of which can be read back.
 *
 * ## A daily rollup, and the reason is privacy rather than storage
 *
 * The obvious alternative is one row per request, which is a real audit trail and a lot of rows.
 * Rows are not what rules it out. **A per-request log keyed by token would let us reconstruct
 * "what did this customer search for"** — the precise question `search_queries` was deliberately
 * built to be unable to answer, with no `org_id` column to join and a rotating digest instead of
 * an identity. Adding a table that answers it through a side door would undo that decision
 * without anybody deciding.
 *
 * So the unit is `(token, day, tool)` and the payload is counts. It answers the questions the
 * commercial and support cases actually ask — *how much is this key using, which tools, since
 * when* — and it cannot answer which skill somebody fetched at 14:32. That limit is stated in
 * the panel rather than discovered.
 *
 * ## Refusals are an `events` row, not a counter here
 *
 * A rate-limit refusal happens in the route guard, **before** any tool is chosen, so it has no
 * tool to be counted against and a sentinel value in the `tool` column would be a lie the next
 * `group by` believes. It is also exceptional and worth detail — which window, which limit, when
 * it lifts — and detail on the rare thing is what an `events` row is for. Successes are
 * countable; failures are investigable.
 */
export const mcpUsage = pgTable(
  "mcp_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => mcpTokens.id, { onDelete: "cascade" }),

    day: date("day").notNull(),
    /** One of the registered tool names. Never a sentinel — see the note on refusals. */
    tool: text("tool").notNull(),

    calls: integer("calls").notNull().default(0),
    /** A tool that threw. Counted apart, because our outage is not the caller's usage. */
    errors: integer("errors").notNull().default(0),

    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * The upsert target, and the reason there is no counter to drift.
     *
     * Incrementing one row per `(token, day, tool)` means the count is the count — the same
     * property `outcome_signals` gets from its dedup index, where counting rows *is* the
     * deduplicated total and no application logic can forget to update a second place.
     */
    uniqueIndex("mcp_usage_uq").on(t.tokenId, t.day, t.tool),
    /** The operator's question: what did this workspace use, over a window. */
    index("mcp_usage_org_day_idx").on(t.orgId, t.day),

    /**
     * The split policy `mcp_tokens` and `llm_usage` already carry, for the same reason and with
     * the same caveat.
     *
     * SELECT is open because usage is read across organisations by an operator panel and by
     * nothing else; INSERT and UPDATE are org-scoped so a workspace can only ever add to its
     * own. Safe **because of the column list**: a token id, a tool name, a day and two integers.
     * No query text, no skill, no address. Add a column carrying what was asked for and this
     * policy becomes wrong.
     */
    pgPolicy("read_all", { for: "select", to: "app_runtime", using: sql`true` }),
    pgPolicy("write_own", {
      for: "insert",
      to: "app_runtime",
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
    pgPolicy("update_own", {
      for: "update",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
