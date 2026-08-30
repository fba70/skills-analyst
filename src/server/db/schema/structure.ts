import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills, skillVersions } from "./corpus";

/**
 * The structural fingerprint of one skill version (Doc 2 R3.2).
 *
 * This is the evidence table archetype mining reads. It exists because the thing we want
 * to mine — *what shape does a good skill in this category have* — is not answerable from
 * `skills` or `skill_versions`: the shape lives in the markdown body, and the body lives
 * in R2, not in Postgres. Aggregating over 500K objects in object storage is not a query.
 * So the shape is extracted once, at a pinned extractor version, and lands here as rows
 * that `group by` can reach.
 *
 * Everything in this table is **derived and deterministic** — no LLM, no network. That is
 * deliberate: a fingerprint has to be recomputable for free when the extractor improves,
 * exactly like a verdict is re-runnable when an analyzer improves. `extractor_version` is
 * the re-scan selector, same contract as `verdicts.analyzer_version`.
 *
 * Column-vs-jsonb split follows what mining actually does with each field: anything an
 * archetype aggregates or filters on is a column (so an index can serve it), and the full
 * detail a curator or exemplar renderer needs is jsonb.
 *
 * Storing this for a `metadata_only` skill is safe and intended: a heading count and a
 * section inventory are facts *about* a document, not the document. No body text is kept
 * here — see `headings`, which stores normalised role labels and short heading strings
 * only. R1.6 forbids mirroring content, not measuring it.
 */
export const skillStructures = pgTable(
  "skill_structures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    /** Denormalised from the version so mining can group by skill without a join. */
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** Bump on ANY extraction change. The selector for a re-extract campaign. */
    extractorVersion: text("extractor_version").notNull(),

    // ---- Heading tree ------------------------------------------------------
    /** `[{ depth, text, role, order }]` — the section inventory, in document order. */
    headings: jsonb("headings").notNull().default(sql`'[]'::jsonb`),
    /** Distinct roles present, deduplicated. The main axis archetypes aggregate on. */
    sectionRoles: text("section_roles").array().notNull().default(sql`'{}'::text[]`),
    headingCount: integer("heading_count").notNull().default(0),
    maxHeadingDepth: smallint("max_heading_depth").notNull().default(0),

    // ---- Body shape --------------------------------------------------------
    bodyBytes: integer("body_bytes").notNull().default(0),
    wordCount: integer("word_count").notNull().default(0),
    codeBlockCount: integer("code_block_count").notNull().default(0),
    codeLanguages: text("code_languages").array().notNull().default(sql`'{}'::text[]`),
    listItemCount: integer("list_item_count").notNull().default(0),
    tableCount: integer("table_count").notNull().default(0),
    /** Prose vs. scaffolding. A skill that is all bullets reads differently to one that is all prose. */
    proseRatio: smallint("prose_ratio").notNull().default(0),

    // ---- Links and progressive disclosure ----------------------------------
    linkCount: integer("link_count").notNull().default(0),
    /** Links pointing at a file inside the bundle — real progressive disclosure (R2.7). */
    internalLinkCount: integer("internal_link_count").notNull().default(0),
    /** Internal links whose target is not in the bundle. An R2.7 finding, kept as a stat. */
    brokenLinkCount: integer("broken_link_count").notNull().default(0),

    // ---- Resource layout ---------------------------------------------------
    fileCount: integer("file_count").notNull().default(1),
    hasScripts: boolean("has_scripts").notNull().default(false),
    hasReferences: boolean("has_references").notNull().default(false),
    hasAssets: boolean("has_assets").notNull().default(false),
    hasTemplates: boolean("has_templates").notNull().default(false),
    /** Every top-level directory in the bundle, so unnamed conventions still show up. */
    resourceDirs: text("resource_dirs").array().notNull().default(sql`'{}'::text[]`),
    fileExtensions: text("file_extensions").array().notNull().default(sql`'{}'::text[]`),

    // ---- Frontmatter conventions -------------------------------------------
    frontmatterKeys: text("frontmatter_keys").array().notNull().default(sql`'{}'::text[]`),
    descriptionLength: integer("description_length").notNull().default(0),
    /** `{ startsWithVerb, hasUseWhen, hasTriggerCue, sentenceCount, ... }` (R2.8). */
    descriptionShape: jsonb("description_shape").notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One fingerprint per version per extractor version — re-extraction supersedes by
    // upsert rather than piling up rows, because unlike a verdict a fingerprint carries
    // no judgement worth keeping history of.
    uniqueIndex("skill_structures_uq").on(t.skillVersionId, t.extractorVersion),
    index("skill_structures_skill_idx").on(t.skillId),
    index("skill_structures_roles_idx").using("gin", t.sectionRoles),
  ],
);
