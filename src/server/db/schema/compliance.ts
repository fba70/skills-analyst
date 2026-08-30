import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { skills, sources } from "./corpus";
import { takedownGrounds, takedownScope, takedownStatus } from "./enums";

/**
 * Takedown requests and their effect (Doc 2 R7.5).
 *
 * The platform mirrors other people's work under their licences. Doc 1 states the
 * obligation to the upstream authors we ingest — who never signed up — as structural:
 * provenance, licence gating, and a takedown path. This is that path, and it is P0
 * compliance rather than a feature: the gap only matters on the day it matters.
 *
 * ## The row outlives what it points at
 *
 * `skillId` and `sourceId` are convenience joins and both are nullable. The columns that
 * carry the *decision* are `sourceUrl` and `skillPath`, duplicated deliberately, because
 * they are the identity the ingest pipeline uses — `syncSource` matches an existing skill
 * on `(source, path)` — and a block has to work when the rows it was recorded against are
 * gone. A takedown keyed only on `skills.id` would be silently lifted the first time a
 * skill row was rebuilt.
 *
 * That is the whole reason this is a table rather than a status column. A withdrawn skill
 * with no persistent record of *why* comes back on the next enumeration, and a takedown a
 * sync can undo is not a takedown.
 *
 * ## Content hash is not the key either
 *
 * Tempting, since storage is content-addressed. But an upstream author who edits the file
 * after asking us to remove it would produce a new hash and walk straight past the block,
 * which is the opposite of what they asked for. Path identity survives an edit; a hash is
 * designed not to.
 *
 * ## Rejected notices are kept
 *
 * A refused claim is still a claim that was made, and the record of having considered it is
 * the half of this workflow that protects the platform. Nothing here is ever deleted; a
 * retraction moves the row to `reinstated`.
 */
export const takedowns = pgTable(
  "takedowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    scope: takedownScope("scope").notNull(),

    /**
     * The block key, and the only part that is load-bearing.
     *
     * `sourceUrl` always; `skillPath` only for a skill-scoped request. A source-scoped row
     * with a null path blocks the whole repository.
     */
    sourceUrl: text("source_url").notNull(),
    skillPath: text("skill_path"),

    /** Convenience joins for the admin list. Null once the target no longer exists. */
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),

    /** Who asked. Recorded because a notice with no sender cannot be acted on or appealed. */
    requester: text("requester").notNull(),
    requesterEmail: text("requester_email"),
    grounds: takedownGrounds("grounds").notNull(),
    /** What they claimed, in their words. The evidence the decision was made against. */
    claim: text("claim").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),

    status: takedownStatus("status").notNull().default("received"),
    /** The admin who decided. R7.1 wants an actor on every state transition. */
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),

    /**
     * Did the stored bytes actually go?
     *
     * Separate from `status` because "we decided to remove it" and "the objects are gone
     * from R2" are different facts, and only the second one is a defence. A partial
     * deletion has to be visible rather than implied by an upheld status.
     */
    contentDeleted: boolean("content_deleted").notNull().default(false),
    /** How many skills the decision actually withdrew. One, or a whole repository's worth. */
    affectedSkills: integer("affected_skills").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * The block lookup, run once per sync before anything is fetched.
     *
     * Leading on `sourceUrl` because that is how the question is asked: "what is blocked in
     * this repository", answered before enumeration turns into downloads.
     */
    index("takedowns_block_idx").on(t.sourceUrl, t.skillPath, t.status),
    index("takedowns_status_idx").on(t.status, sql`${t.receivedAt} desc`),
    index("takedowns_skill_idx").on(t.skillId),
  ],
);
