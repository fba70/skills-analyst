import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { skills } from "./corpus";
import { draftStatus, skillDialect } from "./enums";

/**
 * Skills being authored (Doc 2 R4.x).
 *
 * ## Why this is not a row in `skills`
 *
 * Tempting, and wrong. `skill_versions.source_id` is NOT NULL and points at a repository we
 * sync — a draft has no upstream, so reusing the corpus tables means inventing a fake
 * source per organisation. That fake would then be counted by `platformStats`, offered to
 * `pendingSources`, and folded into source-diversity reporting: the public corpus numbers
 * would move every time somebody opened the builder.
 *
 * A draft is also not the same *kind* of thing. It has no provenance to preserve, no
 * licence to resolve, and no content hash until it has been generated. It becomes a skill
 * when it is published (R4.5's pre-publish gate), and that transition is the moment the
 * corpus tables should hear about it — not before.
 *
 * ## The inputs outlive the output
 *
 * `purpose`, `context` and `sectionInputs` are what the author typed; `body` is what the
 * model made of them. They are stored separately and the inputs are never overwritten by a
 * generation, so re-generating is free of the thing that makes regeneration frightening —
 * you cannot lose your own words by asking for a better draft.
 *
 * ## Pinned to the archetype it was built from
 *
 * `archetypeCategory` and `archetypeVersion` record which skeleton the scaffold came from.
 * R4.1's acceptance criterion asks for exactly this: archetypes move as the corpus grows,
 * and a draft that cannot say which one it followed cannot be re-checked against it later.
 */
export const skillDrafts = pgTable(
  "skill_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * NOT NULL, unlike everywhere else in this schema.
     *
     * A draft always belongs to someone. The corpus tables use a nullable `org_id` because
     * `NULL` means "public", and there is no such thing as a public draft — so the column
     * that is optional for a skill is mandatory here, and the RLS policy is correspondingly
     * stricter: no `org_id IS NULL` escape hatch.
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),

    name: text("name").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary"),

    /** Target format. Drives the frontmatter contract the generated body must satisfy. */
    dialect: skillDialect("dialect").notNull().default("anthropic_skill"),

    /** The function category whose archetype was scaffolded from. */
    archetypeCategory: text("archetype_category").notNull(),
    /** Null when the category had no mined archetype and the draft used a bare skeleton. */
    archetypeVersion: integer("archetype_version"),

    /**
     * What field the skill serves. Optional, and **not** part of the scaffold.
     *
     * Archetypes are mined on the function axis only — structure follows function, so a
     * contract review and a pull-request review share a shape. Domain changes none of that
     * and is stored for the two things it does affect:
     *
     *   - **content.** A review skill for legal and one for code share a skeleton and share
     *     no vocabulary; the model writes better sections when it knows which it is.
     *   - **publishing.** R3.1 wants both axes on a skill and browse runs on domain, so a
     *     draft promoted into the corpus without one would be uncategorised on the axis
     *     users actually filter by.
     *
     * Nullable because a skill can be genuinely domain-neutral, and guessing one would put
     * a wrong label on the axis that decides where it appears.
     */
    domainCategory: text("domain_category"),

    /** What the author said the skill is for. */
    purpose: text("purpose").notNull(),
    /** Their workflow, constraints, existing scripts — R4.3's custom input. */
    context: text("context"),
    /** Section role → what the author wants in it. Their words, never overwritten. */
    sectionInputs: jsonb("section_inputs").notNull().default(sql`'{}'::jsonb`),
    /**
     * The section roles the scaffold proposed, in order.
     *
     * Recorded because R6.2 asks which suggested sections authors keep versus delete, and
     * that is unanswerable without knowing what was suggested. Archetypes move between a
     * draft being scaffolded and published, so re-deriving the list later would compare the
     * author's choices against a skeleton they never saw.
     */
    scaffoldSections: jsonb("scaffold_sections").notNull().default(sql`'[]'::jsonb`),

    status: draftStatus("status").notNull().default("collecting"),

    /** The generated SKILL.md body, frontmatter excluded. */
    body: text("body"),
    frontmatter: jsonb("frontmatter").notNull().default(sql`'{}'::jsonb`),
    /** Which model wrote it, so a bad batch is identifiable after a model change. */
    model: text("model"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /** Set when the model refused (R5.5) or the call failed. Shown to the author. */
    failureReason: text("failure_reason"),

    /**
     * The skill this draft became (R6.1).
     *
     * Set on publish and never cleared. Keeping the draft alongside the skill is what makes
     * lineage legible in both directions: the skill's provenance names the draft, and the
     * draft names the skill, so "what was this authored from" and "what did this become"
     * are both one hop.
     */
    publishedSkillId: uuid("published_skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),

    /** Last validation pass over the generated body (R4.5). Findings included. */
    validation: jsonb("validation"),
    qualityScore: smallint("quality_score"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_drafts_org_idx").on(t.orgId, sql`${t.updatedAt} desc`),
    index("skill_drafts_status_idx").on(t.status),
  ],
);
