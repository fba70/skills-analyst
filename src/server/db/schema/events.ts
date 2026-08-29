import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { actorType } from "./enums";

/**
 * The audit log, and the observability of record (Doc 2 R7.1).
 *
 * Every state transition lands here: indexed, quarantined, tombstoned, sync started,
 * archetype updated. Append-only. Because it carries actor, reason and analyzer version,
 * any incident is reconstructible by query, and the events table is also the path back
 * if a table above it ever has to be rebuilt.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    actorType: actorType("actor_type").notNull(),
    /** User id, analyzer id, api key id — NULL for anonymous system ticks. */
    actorId: text("actor_id"),

    /** Dotted verb, e.g. "skill_version.quarantined", "source.sync.started". */
    kind: text("kind").notNull(),
    /** Table name of the thing acted on, e.g. "skill_versions". */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),

    /** Human-readable why, when there is one. */
    reason: text("reason"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_subject_idx").on(t.subjectType, t.subjectId, t.at),
    index("events_kind_idx").on(t.kind, t.at),
    index("events_at_idx").on(t.at),
  ],
);
