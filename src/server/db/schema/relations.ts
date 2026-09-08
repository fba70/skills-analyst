import { sql } from "drizzle-orm";
import {
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { skills } from "./corpus";

/**
 * Edges with nowhere else to live (Doc 6 RK.3, plan step E2).
 *
 * ## What is deliberately absent
 *
 * No `similar-to` and no `supersedes`. Both already have a home — the A6 vectors and
 * `skills.superseded_by` — and storing them here would be two snapshots that go stale silently:
 * a re-embed moves similarity, and A4 made supersession a *live join* precisely so a replacement
 * quarantined since stops being recommended. `relationsFor` composes those at read time.
 *
 * What is here is what cannot be recomputed cheaply: **mined conflicts**, which cost a model call
 * per pair, and **author-declared** edges, which are somebody's assertion and exist nowhere else.
 *
 * ## Directed rows, written in pairs for symmetric kinds
 *
 * `conflicts-with` reads the same from either end, and there are two ways to store that: one row
 * with a canonical ordering, or two rows written together. Two rows, because every read becomes
 * `where from_skill_id = $1` — no `or`, no ordering convention a later query can forget, and the
 * miner is the only writer so the pair cannot drift.
 */
export const skillRelations = pgTable(
  "skill_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Null for the public corpus, as everywhere else. A private skill's edges stay inside. */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    fromSkillId: uuid("from_skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    toSkillId: uuid("to_skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    /** One of `STORED_KINDS`. The derived kinds are refused by the writer, not by a constraint. */
    kind: text("kind").notNull(),
    /** `declared` or `mined`. An assertion and a measurement are not the same claim. */
    source: text("source").notNull(),

    /**
     * Why, in one line — for a mined conflict, the two guardrails that disagree.
     *
     * Stored rather than resolved, unlike an archetype exemplar, and the reason is the opposite
     * of that case: an exemplar must stop being quoted when it is withdrawn, while a conflict's
     * *evidence* is a statement about the documents as they were when the model read them. Both
     * texts are the skills' own, both skills are already visible to anyone who can see this row,
     * and re-deriving the pair later would need the model call again.
     */
    detail: text("detail"),

    /** Which detector decided. The re-mine selector, and R7.2's reproducibility. */
    minerVersion: text("miner_version"),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One edge per ordered pair per kind. The upsert target and the dedup. */
    uniqueIndex("skill_relations_uq").on(t.fromSkillId, t.toSkillId, t.kind),
    /** Every read: the edges out of one skill. */
    index("skill_relations_from_idx").on(t.fromSkillId, t.kind),
    /** The re-mine selector. */
    index("skill_relations_miner_idx").on(t.source, t.minerVersion),

    /**
     * `org_id IS NULL` is the public corpus. The clause is what keeps a Team-tier private skill's
     * edges inside its tenant when R1.9 lands — and an edge is more revealing than it looks: a
     * `conflicts-with` between two private skills describes how a customer's own work disagrees
     * with itself.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
