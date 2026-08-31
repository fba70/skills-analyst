import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills } from "./corpus";
import { skillDrafts } from "./drafts";

/**
 * What authoring taught us (Doc 2 R6.2), bounded against poisoning (R6.5).
 *
 * One row per (draft, section role) at the moment a draft is published. This is the return
 * arrow: §2 says *the loop is the product*, and until now archetype regeneration had only
 * corpus prevalence to learn from — what people published elsewhere, never what happened
 * when someone actually used the skeleton.
 *
 * ## Structure only. Never content.
 *
 * Every column here is either a boolean or a value from a closed vocabulary we defined: the
 * function category, and a section role from the fourteen in `SECTION_ROLES`. **No skill
 * text, no names, no descriptions, no author input.** That is what makes this compatible
 * with RC.5 and OQ-C2, which forbid org-private corpora feeding public archetypes even in
 * aggregate: "the `troubleshooting` heading survived into a published skill" is a fact about
 * our own vocabulary, not about a customer's workflow.
 *
 * The minimum-distinct-organisations floor applied at aggregation time is the second half of
 * that guarantee. It exists for R6.5's anti-poisoning reasons *and* for privacy — below the
 * floor an aggregate could describe a single tenant, so it is not published at all. One
 * mechanism, two requirements, and it would be wrong to relax it for either.
 *
 * ## Deduplicated by construction
 *
 * `(draft_id, section_role)` is unique. R6.5 asks for deduplication per identity, and a
 * draft is the identity that matters: one authoring session contributes one opinion per
 * section, however many times it is regenerated or republished. Making that a database
 * constraint rather than application logic means a retry cannot double-count.
 */
export const builderSignals = pgTable(
  "builder_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** NOT NULL, like drafts. Used for rate-limiting and the distinct-org floor, never published. */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),
    /** The skill it became. Null if that skill is later deleted; the signal survives. */
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),

    /** Function category, from the closed taxonomy. */
    archetypeCategory: text("archetype_category").notNull(),
    /** Which skeleton was followed. Null when the category had no archetype. */
    archetypeVersion: integer("archetype_version"),
    /** A role from `SECTION_ROLES`. Never a raw heading. */
    sectionRole: text("section_role").notNull(),

    /** The scaffold proposed this section. */
    offered: boolean("offered").notNull(),
    /** The author wrote notes for it — engagement, distinct from survival. */
    authored: boolean("authored").notNull(),
    /** A heading for this role is present in the published document. */
    survived: boolean("survived").notNull(),
    /**
     * The published skill passed validation on its first pass (G3).
     *
     * Denormalised onto every row of the draft rather than kept once: the question these
     * rows answer is "which archetype elements correlate with first-pass success", and that
     * correlation is computed per section, so the outcome has to sit beside the section.
     */
    firstPassValid: boolean("first_pass_valid").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // R6.5's dedup, as a constraint rather than a convention.
    uniqueIndex("builder_signals_draft_role_uq").on(t.draftId, t.sectionRole),
    index("builder_signals_category_idx").on(t.archetypeCategory, t.sectionRole),
    index("builder_signals_org_idx").on(t.orgId, t.createdAt),
  ],
);
