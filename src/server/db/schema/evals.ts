import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { skills } from "./corpus";
import { skillDrafts } from "./drafts";
import { interviewCandidates } from "./interview";

/**
 * Skill CI (Doc 2 R2.11, Doc 6 RW.6, plan step D1).
 *
 * ## One probe table, and the plan says why
 *
 * An earlier ordering had RW.8's trigger lab independent of Skill CI. That would have built two
 * probe tables, and should-trigger cases and trigger probes are the same concept at different
 * aggregation levels — so D2 reads exactly these rows rather than a parallel set that could
 * disagree with them about whether a skill fires.
 *
 * ## Two parents, exactly one set
 *
 * A case belongs to a draft while it is being written and to a skill once it is published, and
 * `publishDraft` re-points it at the moment the draft becomes the skill. Two nullable foreign
 * keys with a check constraint rather than a `subject_type`/`subject_id` pair, because the pair
 * would give up referential integrity and the cascade — and an eval pointing at a deleted draft
 * is a row nothing can ever run again.
 *
 * ## Org-owned, even for a public skill
 *
 * `org_id` is NOT NULL. A case written against a corpus skill is the workspace's own claim
 * about what that skill should do, not a fact about the skill — so it stays inside the tenant,
 * and RC.5 holds without a special case. If a public eval corpus is ever wanted it is a
 * different table with a different policy, not a nullable column here.
 */
export const skillEvals = pgTable(
  "skill_evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id").references(() => skillDrafts.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "cascade" }),

    /** One of `EVAL_KINDS`. */
    kind: text("kind").notNull(),
    /** The request, or the task input. */
    prompt: text("prompt").notNull(),
    /** What makes the answer right. Golden tasks only; null for the trigger probes. */
    expectation: text("expectation"),

    /** `authored` or `interview` — see `EVAL_SOURCES`. */
    source: text("source").notNull().default("authored"),
    /**
     * The captured worked example this came from (RW.4).
     *
     * Set null on delete rather than cascade: a case is worth keeping after the interview it
     * came from is gone, and losing eval coverage because somebody tidied a transcript would be
     * the "recorded then discarded" shape this codebase has hit four times.
     */
    sourceCandidateId: uuid("source_candidate_id").references(() => interviewCandidates.id, {
      onDelete: "set null",
    }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_evals_draft_idx").on(t.draftId, t.createdAt),
    index("skill_evals_skill_idx").on(t.skillId, t.createdAt),

    /**
     * Exactly one parent, enforced by the database rather than by every writer remembering.
     *
     * Both null is an orphan nothing can run; both set is a case that would appear twice and
     * whose runs could not be attributed. Neither is expressible in the type system across a
     * network boundary, which is what a check constraint is for.
     */
    check(
      "skill_evals_one_parent",
      sql`(draft_id is null) <> (skill_id is null)`,
    ),

    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * One execution of one case against one document.
 *
 * ## Append-only, like `verdicts` and for the same reason
 *
 * A run is evidence, and the history is what makes a **regression** detectable: this case
 * passed against an earlier document and fails against this one. Collapse the history into a
 * "current verdict" column and the only question the publish gate needs answered becomes
 * unanswerable — you would know a case is failing and not whether it ever worked.
 *
 * So no UPDATE and no DELETE policy. Maintenance goes through the owner connection migrations
 * already use, the same posture as `llm_usage` and `draft_revisions`.
 *
 * ## `content_hash` is the staleness key, and it is why nothing auto-runs
 *
 * The plan says "every edit re-runs". Taken literally that bills a model call for every save in
 * a block-editing session. What it is *for* is that a result must never describe an older
 * document — and stamping the run with the document's hash gets that property exactly, for
 * free, and more honestly: a stale result is visibly stale rather than being quietly replaced
 * by a run the author did not ask for and did not budget for.
 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    evalId: uuid("eval_id")
      .notNull()
      .references(() => skillEvals.id, { onDelete: "cascade" }),

    /** sha256 of the document this run judged. The publish gate compares against it. */
    contentHash: text("content_hash").notNull(),

    /** One of `EVAL_VERDICTS`. `error` is ours, not the skill's — see the vocabulary. */
    verdict: text("verdict").notNull(),
    /** Why, in the judge's words. Shown to the author; never used as a score. */
    detail: text("detail"),
    /** 0–100 for a trigger probe. Null for a golden task, which is pass or fail. */
    confidence: smallint("confidence"),

    /**
     * Which arm of the with/without matrix this run is (Doc 6 RW.7, plan step D3).
     *
     * **NULL is a Skill CI run**, and that is the load-bearing value. D1's verdict, staleness
     * and regression logic reads the newest run per case, so a matrix arm landing in that
     * stream would be read as the case's current state — and a *without-the-skill* failure,
     * which is the arm working correctly, would look like a regression and block the publish.
     * `evalStates` filters on `with_skill is null` for exactly that reason.
     *
     * A boolean rather than an arm enum because the model is already a column: the four cells
     * are `(with_skill, model)`, and inventing a second name for a pair the row already carries
     * is how two descriptions of one thing start to disagree.
     */
    withSkill: boolean("with_skill"),

    /** Which model decided, so a verdict batch is identifiable after a model change. */
    model: text("model").notNull(),
    /** What this run cost, denormalised from the ledger for a per-run figure on screen. */
    costMicros: integer("cost_micros").notNull().default(0),

    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("eval_runs_eval_idx").on(t.evalId, sql`${t.runAt} desc`),
    /** The matrix reads one case's arms at one document; CI reads neither. */
    index("eval_runs_matrix_idx").on(t.evalId, t.withSkill, t.contentHash),

    /**
     * SELECT and INSERT only. A run that the application can rewrite is not evidence, and the
     * publish gate reads these rows — an app that could edit them could clear its own gate.
     */
    pgPolicy("org_read", {
      for: "select",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
    }),
    pgPolicy("org_append", {
      for: "insert",
      to: "app_runtime",
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
