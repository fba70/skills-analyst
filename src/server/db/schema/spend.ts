import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { llmPurpose } from "./enums";

/**
 * The metering ledger (Doc 2 RC.2, RC.3).
 *
 * Append-only. One row per model call, written after the call returns, carrying what was
 * spent and on whose behalf. RC.3 wants usage "reconstructible and auditable"; an
 * append-only ledger is the shape that makes a bill reproducible from first principles
 * rather than from a counter somebody might have reset.
 *
 * ## Why a ledger and not a running total
 *
 * A counter is one number that can be wrong in ways nobody can reconstruct. A ledger can be
 * re-summed, audited, disputed, and re-priced when a rate changes. Caps are enforced by
 * summing the current month, which costs one indexed aggregate and is worth it.
 *
 * ## Why micro-dollars
 *
 * A single call often costs a fraction of a cent. Floating point accumulated over thousands
 * of rows drifts, and a budget that disagrees with the sum of its own ledger is worse than
 * no budget. `bigint` micro-dollars are exact; $1 is 1,000,000.
 *
 * ## `org_id` is nullable here, unlike drafts
 *
 * Null means platform work — corpus taxonomy and corpus validation, which belong to the
 * global budget rather than to any customer. That is the distinction RC.2 draws between
 * per-org caps and the separate platform budget, and it is expressed as the presence or
 * absence of an owner rather than as a flag that could disagree with `purpose`.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Null for platform work. See the note above. */
    orgId: text("org_id").references(() => organization.id, { onDelete: "set null" }),
    purpose: llmPurpose("purpose").notNull(),

    model: text("model").notNull(),

    /** Input tokens billed at the full rate — cache misses only. */
    inputTokens: integer("input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),

    /**
     * Cost in millionths of a dollar, priced at the moment of the call.
     *
     * Stored rather than recomputed, because rates change and a historical bill must not
     * move when they do. The token counts are kept beside it so a re-pricing is always
     * possible on purpose rather than by accident.
     */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),

    /** What the call was about, for tracing a charge back to a thing. */
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The cap query: sum one org's current month. Leading on org and time because that is
    // exactly how it is asked, on a path that runs before every billable call.
    index("llm_usage_org_at_idx").on(t.orgId, t.at),
    index("llm_usage_purpose_at_idx").on(t.purpose, t.at),
  ],
);
