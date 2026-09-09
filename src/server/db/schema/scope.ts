import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills, skillVersions } from "./corpus";

/**
 * Scope and disclosure analysis (Doc 6 RW.10 / RW.11, plan step C5).
 *
 * ## The verdict is stored; the vectors are not
 *
 * Judging one skill means embedding each of its blocks — roughly 36 vectors at 1,536 dimensions
 * — and there is no second consumer for them. Storing 1.6 million block vectors to keep one
 * verdict per document would be about ten gigabytes for a number that fits in a `real`, and it
 * would be a **second population of embeddings** sitting beside A6's with a different
 * composition, which is precisely the incomparability `EMBEDDER_VERSION` exists to prevent.
 *
 * So the vectors are computed, used and dropped. Re-analysing a skill costs a fraction of a
 * cent, which is the right trade while the metric is still being tuned — and tuning it is the
 * whole point of running this over the corpus before pointing it at anybody's draft.
 *
 * ## Keyed on the version, and on the analyser that judged it
 *
 * A scope verdict is a claim about specific bytes: re-sync produces a new version whose blocks
 * may differ, and a verdict carried forward would describe a document nobody has read.
 * `analyser_version` is in the key for the same reason `analyzer_version` is on a verdict —
 * changing a threshold must not silently re-label a corpus that was never re-measured, and the
 * pair is what makes a re-run selector possible.
 */
export const skillScope = pgTable(
  "skill_scope",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Null is the public corpus, as everywhere else. */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** `SCOPE_ANALYSER_VERSION`. The re-run selector and R7.2's reproducibility. */
    analyserVersion: text("analyser_version").notNull(),
    /**
     * The block embedder's own version string.
     *
     * Separate from A6's `EMBEDDER_VERSION` because the unit and the composition are different
     * — one embeds a skill's claim, the other embeds a passage — and a verdict that could not
     * say which produced it would be unreproducible the first time either moved.
     */
    embedderVersion: text("embedder_version").notNull(),

    /* ------------------------------------------------------------- RW.10 */

    /** How many blocks were long enough to embed. Below the floor, the verdict is unmeasurable. */
    blocks: integer("blocks").notNull(),
    /** Mean pairwise cosine over every analysed block. High is one subject. */
    cohesion: real("cohesion").notNull(),
    /** `1 − cosine` between the two cluster centres. Null when there was nothing to split. */
    separation: real("separation"),
    /**
     * How much of the split the block types explain.
     *
     * Stored rather than folded into the verdict, because it is the number that says whether to
     * *believe* the verdict — a split at 0.69 purity and one at 0.20 are both `split-candidate`
     * and only the second is interesting. Null when either half was mostly unclassified.
     */
    type_purity: real("type_purity"),
    /** One of `SCOPE_VERDICTS`. */
    verdict: text("verdict").notNull(),
    /**
     * The two halves, as block ids in document order, plus each half's dominant type.
     *
     * Ids rather than text: this table follows `skill_blocks` in holding **no body content**, so
     * the proposed split resolves live through the same licence gate the block library uses. A
     * stored copy of somebody's prose would go on being quotable after a takedown.
     */
    clusters: jsonb("clusters").notNull().default(sql`'{}'::jsonb`),

    /* ------------------------------------------------------------- RW.11 */

    bodyBytes: integer("body_bytes").notNull(),
    /** True when the body is over the validator's own `DISCLOSURE_HINT_BYTES`. */
    oversized: boolean("oversized").notNull().default(false),
    /** Estimated activation tokens returned if every candidate moved to `references/`. */
    movableTokens: integer("movable_tokens").notNull().default(0),
    /** Block ids, word counts, token estimates and centrality. No text, same rule as above. */
    candidates: jsonb("candidates").notNull().default(sql`'[]'::jsonb`),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One verdict per version per analyser. Re-running replaces rather than accumulating. */
    uniqueIndex("skill_scope_uq").on(t.skillVersionId, t.analyserVersion),
    /** The corpus finding: how many of each verdict, at the current analyser. */
    index("skill_scope_verdict_idx").on(t.analyserVersion, t.verdict),
    /** The re-run selector: versions with no row at this analyser version. */
    index("skill_scope_version_idx").on(t.skillId, t.analyserVersion),

    /**
     * The `skill_relations` policy. A scope verdict about a private skill is a statement about
     * a customer's own corpus — *"this is really two skills"* is a fact about their work — and
     * belongs inside their tenant.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
