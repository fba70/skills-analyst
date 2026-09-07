import { sql } from "drizzle-orm";
import {
  boolean,
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
import { skills, skillVersions, sources } from "./corpus";
import {
  flagReason,
  flagStatus,
  takedownGrounds,
  takedownScope,
  takedownStatus,
} from "./enums";

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

/**
 * A reader's report about a skill (Doc 2 R2.5).
 *
 * ## Its own table, not a takedown
 *
 * A takedown is a legal claim by a rights-holder and its consequence is withholding content.
 * A flag is a quality or safety observation by a reader and its consequence is a curator
 * looking again. They share a shape — recorded, then decided — and share nothing else:
 * different vocabulary, different evidence, different outcome. Folding them together would
 * mean either treating "the description is wrong" as a legal notice or treating a copyright
 * claim as a quality nit.
 *
 * ## `received` enforces nothing
 *
 * A flag quarantines no skill and changes no score until a curator upholds it. Enforcing on
 * arrival means anybody who can fill in a form can un-list a competitor, and the temptation
 * is strongest exactly where the attacker would aim — a credible-sounding `malicious` report.
 * The same rule governs the R6.3 outcome signal: only an **upheld** flag records one, because
 * `flagged` is an adverse outcome and a received one would let an accusation alone bar a
 * skill from `battle-tested`.
 *
 * ## No reporter identity
 *
 * `reporter_digest` is the same daily-rotating unlinkable HMAC the outcome signals use, and
 * it is here for two jobs only: refusing a duplicate report of the same skill for the same
 * reason on the same day, and giving the rate limiter something to count. An optional
 * `contact` is stored **only when the reporter volunteers one** — a curator sometimes needs
 * to ask a follow-up question, and a report nobody can clarify is often a report nobody can
 * action.
 *
 * ## The note is untrusted input
 *
 * It is a reader's free text about content that may itself be adversarial, displayed to a
 * curator and never rendered as markup, never interpolated into a prompt without the R7.3
 * fence. Capped, so the field is not a channel for pasting a payload.
 */
export const skillFlags = pgTable(
  "skill_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULL for the public corpus, which is every flag today. */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /**
     * The version the reader was looking at.
     *
     * Pinned, because "this is broken" is a statement about content, and a re-sync may have
     * replaced it before a curator reads the flag. Without the version a curator cannot tell
     * a stale report from a live one.
     */
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    reason: flagReason("reason").notNull(),
    /** The reader's own words. Untrusted; capped; never rendered as markup. */
    note: text("note"),
    /** Volunteered by the reporter, or NULL. Never derived from a request. */
    contact: text("contact"),

    status: flagStatus("status").notNull().default("received"),
    /** Set when a curator decides. Their reasoning, not the reporter's. */
    decision: text("decision"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),

    /** Daily-rotating, unlinkable. See the note above. */
    reporterDigest: text("reporter_digest").notNull(),
    day: date("day").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One report per reader per skill per reason per day.
     *
     * Enforced in the index rather than in the action, so a second entry point cannot forget
     * it. A reader who genuinely has two different problems with one skill files two
     * reasons, which is the distinction worth preserving.
     */
    uniqueIndex("skill_flags_uq").on(t.skillVersionId, t.reason, t.day, t.reporterDigest),
    /** The curator queue: everything still awaiting a decision. */
    index("skill_flags_status_idx").on(t.status, t.createdAt),
    index("skill_flags_skill_idx").on(t.skillId),

    /**
     * Reads are open; writes are org-scoped.
     *
     * A curator triaging the queue is reading across every organisation by definition, and
     * the columns carry a reason from a closed vocabulary, a reader's note and an optional
     * volunteered contact. That last one is the reason this policy deserves a second look if
     * the table ever grows: it is the only column here that could identify a person, it is
     * only ever present because somebody typed it, and it must never be exposed on a public
     * surface.
     */
    pgPolicy("read_all", {
      for: "select",
      to: "app_runtime",
      using: sql`true`,
    }),
    pgPolicy("org_write", {
      for: "insert",
      to: "app_runtime",
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
    pgPolicy("org_decide", {
      for: "update",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
