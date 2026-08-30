import {
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills } from "./corpus";
import { categoryAxis, categoryAssignedBy } from "./enums";

/**
 * Category assignments (Doc 2 R3.1).
 *
 * A table rather than the `skills.categories` text[] that shipped in 0000, because R3.1
 * asks for three things an array cannot hold: **multi-label with confidence**, a record of
 * **who assigned it** (classifier or curator), and a **low-confidence review queue**. The
 * array stays as the denormalised read path for listing and filtering; this is the source
 * of truth that writes it.
 *
 * ## Two axes, not one tree
 *
 * `axis` is the part worth explaining. Categorising skills on a single list conflates two
 * independent questions:
 *
 *   - **domain** — what field the skill serves (marketing, devops, legal, …)
 *   - **function** — what the skill *does* (review, generate-document, extract-data, …)
 *
 * They are independent, and they are used for different things. Structure correlates with
 * *function*, not domain: a skill that reviews a marketing brief and one that reviews a
 * pull request share a shape — rubric, severity levels, output format — while a skill that
 * writes an HR policy and one that writes a landing page share a different shape, template
 * and placeholders and examples. Domain changes the vocabulary; function changes the
 * skeleton.
 *
 * So archetypes (R3.2) are mined per **function**, and browse/filter runs on **domain**.
 * Mining on domain would average a rubric together with a template and produce a skeleton
 * that fits neither.
 *
 * A skill carries labels on both axes: `domain: marketing` + `function: generate-document`.
 */
export const skillCategories = pgTable(
  "skill_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    axis: categoryAxis("axis").notNull(),
    /** A slug from the curated vocabulary in `src/server/taxonomy/vocabulary.ts`. */
    value: text("value").notNull(),

    /** 0–100. Below the review floor the assignment is held, not served. */
    confidence: smallint("confidence").notNull(),
    assignedBy: categoryAssignedBy("assigned_by").notNull(),

    /** Pinned so a taxonomy re-run is a re-classification, not a mutation (R7.2). */
    classifierVersion: text("classifier_version").notNull(),
    /** The gateway model id that produced it, e.g. `anthropic/claude-haiku-4.5`. */
    model: text("model"),
    /** One short sentence from the classifier. Shown to the curator, never to ranking. */
    rationale: text("rationale"),

    /** Set when a curator confirmed or overrode. A reviewed row is never re-classified. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_categories_uq").on(t.skillId, t.axis, t.value),
    index("skill_categories_axis_idx").on(t.axis, t.value),
    // Serves the curator queue: low confidence, not yet reviewed, worst first.
    index("skill_categories_review_idx").on(t.confidence, t.reviewedAt),
  ],
);
