import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills, skillVersions } from "./corpus";

/**
 * What a corpus skill's decision rules branch on (Doc 7 RD.5, plan step P7).
 *
 * ## One row per version, even when the answer is "nothing"
 *
 * The obvious shape is a row per extracted parameter, and it has a bug that this codebase has
 * already paid for twice. Absence of rows would then mean **both** *not examined yet* and
 * *examined and found to branch on nothing* — and the second is a perfectly ordinary answer for
 * a skill whose rules are `if it looks wrong, say so`. P1's tool resolver keyed on exactly that
 * absence and re-read the same 28,035 versions for 776 passes, printing progress the whole time;
 * E1's link checker starved its own queue the same way.
 *
 * So the unit is the **examination**: one row per `(version, analyser)`, carrying the parameters
 * it found as jsonb, `[]` included. The selector is `not exists (… and analyser_version = …)`,
 * which cannot lie about what has been looked at, and a re-run is free for everything done.
 *
 * ## It holds model output about a passage, never the passage
 *
 * `skill_blocks` stores offsets and no text so a withdrawn skill stops being quotable at once,
 * and `skill_scope` stores block ids for the same reason. A parameter **name** is not the
 * author's prose — it is our reading of what their rule turns on, in one or two words, and it is
 * the thing that has to be comparable across 23,000 documents. Values are kept beside it as the
 * evidence clustering needs, and no surface prints them: Doc 7 RD.5 says what reaches an author
 * is the parameter name and its two band percentages, never a corpus skill's values or actions.
 *
 * The scan in `verify:decision-surface` asserts no column here could hold a sentence.
 */
export const skillParameters = pgTable(
  "skill_parameters",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Null is the public corpus. Extraction only ever runs over public skills (RC.5, OQ-C2). */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** `PARAMETER_ANALYSER_VERSION`. In the key, so a prompt change re-reads rather than mixes. */
    analyserVersion: text("analyser_version").notNull(),

    /** Which model read it, so a batch is identifiable after the setting moves. */
    model: text("model").notNull(),

    /**
     * `ExtractedParameter[]` — `{ name, kind, values }`, as the model read them, unclustered.
     *
     * Raw on purpose. Clustering and the curated vocabulary are applied at **read** time, so
     * widening the vocabulary is a query rather than a re-extraction of 23,000 documents at a
     * model call each — the architecture `skill_tools` has against `skill_structures.tool_refs`,
     * and the reason that one cost a minute instead of an afternoon.
     */
    parameters: jsonb("parameters").notNull().default(sql`'[]'::jsonb`),

    /** Decision-rule blocks read. Zero is a real answer and is why this row can be empty. */
    blocksRead: integer("blocks_read").notNull().default(0),

    /** What this examination cost, denormalised from the ledger for a per-skill figure. */
    costMicros: integer("cost_micros").notNull().default(0),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One examination per version per analyser. Re-running replaces rather than accumulating. */
    uniqueIndex("skill_parameters_uq").on(t.skillVersionId, t.analyserVersion),
    index("skill_parameters_skill_idx").on(t.skillId, t.analyserVersion),

    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
