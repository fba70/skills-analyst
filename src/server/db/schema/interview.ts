import { sql } from "drizzle-orm";
import {
  index,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { draftBlocks, skillDrafts } from "./drafts";

/**
 * Interview mode (Doc 6 RW.4, plan step C2b).
 *
 * Three tables, and the split is not arbitrary: a **session** is a technique applied to a
 * draft, a **turn** is one exchange, and a **candidate** is one typed block the assistant
 * proposed and the author judged. Only the third carries a decision, and the decision is the
 * whole of R5.4 — so it has to be a row that can be updated and counted, not a field inside a
 * transcript blob.
 *
 * ## Why the transcript is not jsonb on the session
 *
 * `draft_revisions` stores a snapshot as jsonb because it is immutable history read whole. A
 * transcript is the opposite: it is appended to, its rows are joined against candidates, and
 * "which technique produced accepted blocks" is a query over it. Same judgement, opposite
 * answer, and the reason is what gets read rather than what gets written.
 */

export const interviewSessions = pgTable(
  "interview_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Denormalised for RLS, exactly as on `draft_blocks`. */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),

    /** One of `INTERVIEW_TECHNIQUES`. Recorded so accept rates can be read per technique. */
    technique: text("technique").notNull(),

    /** `active` or `ended`. A session is ended by the author, by the cap, or by the budget. */
    status: text("status").notNull().default("active"),
    /** Why it ended — an author leaving and a budget refusal are different facts. */
    endedReason: text("ended_reason"),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interview_sessions_draft_idx").on(t.draftId, sql`${t.createdAt} desc`),

    /**
     * No `org_id IS NULL` escape hatch, matching `skill_drafts` and `draft_blocks`. There is
     * no such thing as a public draft, so there is no such thing as a public interview about
     * one — and a transcript is the most private thing in this schema, because it is somebody
     * describing how their organisation actually works.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

export const interviewTurns = pgTable(
  "interview_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),

    /** 0-based and contiguous within a session. */
    turnOrder: smallint("turn_order").notNull(),
    /** `assistant` or `author`. */
    role: text("role").notNull(),
    text: text("text").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("interview_turns_uq").on(t.sessionId, t.turnOrder),
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * One typed block the assistant proposed, and what the author did with it.
 *
 * ## The decision column is R5.4, and it is why this is a table
 *
 * R5.1 asks the assistant to elicit; R5.4 asks for feedback on each suggestion. Those are one
 * motion here — accepting or rejecting a candidate *is* the feedback, so there is no separate
 * "was this useful?" control anywhere, which is the control everybody ignores.
 *
 * That only works if a decision is a durable, countable row. Buried in a transcript blob it
 * would be unqueryable, and the question it exists to answer — which technique, and which
 * block type, actually produce blocks authors keep — is a `group by` over exactly this table.
 *
 * ## A rejected candidate is kept
 *
 * Same reasoning as a rejected flag and a rejected takedown: the rejection is the signal. A
 * technique whose candidates are always rejected is a technique to prune (Doc 6 §7 anticipates
 * exactly that), and deleting the rows would leave nothing to prune it on.
 *
 * ## `draft_block_id` on delete set null, not cascade
 *
 * An accepted candidate points at the block it became. Deleting that block later — an ordinary
 * edit — must not delete the record that the suggestion was accepted, or the accept rate would
 * silently improve every time somebody tidied their draft.
 */
export const interviewCandidates = pgTable(
  "interview_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),
    /** The assistant turn that proposed it. */
    turnId: uuid("turn_id")
      .notNull()
      .references(() => interviewTurns.id, { onDelete: "cascade" }),

    /** One of `BLOCK_TYPES`. Never null here: an untyped suggestion is not a suggestion. */
    type: text("type").notNull(),
    /** What the assistant wrote, as proposed. Never overwritten — see `editedText`. */
    text: text("text").notNull(),

    /** One of `CANDIDATE_DECISIONS`. */
    decision: text("decision").notNull().default("pending"),
    /**
     * The author's version, when they changed it before accepting.
     *
     * Stored beside the original rather than replacing it, because the pair is the signal: how
     * far a kept suggestion had to move is a better measure of whether the assistant is helping
     * than a count of accepts. Same reasoning as `skill_drafts` keeping the author's inputs
     * separate from what the model made of them.
     */
    editedText: text("edited_text"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),

    /**
     * A worked example, split into the two halves an eval case needs (RW.4 → RW.6).
     *
     * An `example` block holds an input and its output as one passage, which is right for a
     * document and useless as a golden task — a case needs the request in one field and what
     * makes the answer right in another. Splitting a stored passage afterwards would be a
     * convention-parser that drifts, and inferring it with a second model call would put words
     * in the author's mouth on the one surface whose value is that the words are theirs.
     *
     * So the turn that writes the example states both halves in the same call. Same content,
     * structured; no extra cost and nothing invented. Null for every other block type, and
     * null when the model declined to split — an example it could not separate is one that was
     * not really an input/output pair, and `decide.ts` correctly makes no case from it.
     */
    evalPrompt: text("eval_prompt"),
    evalExpectation: text("eval_expectation"),

    /** The draft block this became, when accepted. Null while pending or rejected. */
    draftBlockId: uuid("draft_block_id").references(() => draftBlocks.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interview_candidates_session_idx").on(t.sessionId, t.createdAt),
    index("interview_candidates_decision_idx").on(t.decision, t.type),
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
