import { sql } from "drizzle-orm";
import {
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
import { categoryAxis } from "./enums";

/**
 * Structural archetypes — what a good skill in a category actually looks like (Doc 2 R3.2).
 *
 * The novel piece. Registries collect skills and builders generate them; nothing carries
 * what the corpus *proves works* back into creation. An archetype is that carrier: a
 * skeleton derived from evidence, versioned, and traceable to the skills it came from.
 *
 * ## Append-only, like verdicts
 *
 * A regeneration writes a new row; it never edits the previous one. Two reasons, and the
 * second is the one that matters. R7.2 wants any archetype reproducible from stored inputs
 * — impossible if history is overwritten. And R3.5 wants archetype *evolution* — diffing
 * version N against N-1 to show how conventions drift — which is only available if N-1 is
 * still there. The changelog on each row records what moved and why.
 *
 * ## Mined per function, not per domain
 *
 * `axis` exists so the table can hold either, but in practice every row is a `function`.
 * Structure follows function: a skill that reviews a contract and one that reviews a pull
 * request share a shape — rubric, severity levels, output format — while one that writes an
 * HR policy and one that writes a landing page share a different shape. Mining per domain
 * would average a rubric together with a template and produce a skeleton fitting neither.
 *
 * ## Evidence is counted in structures, not skills
 *
 * `distinctStructures` and `sourceCount` are stored beside `skillCount` because the gate is
 * on the first two. One repository supplied 89% of this corpus at one point, and 85% of
 * those skills shared a single generated skeleton — enough to clear a raw-count threshold
 * alone and produce an "archetype" describing one generator. The stored numbers make that
 * failure visible in the row itself rather than only in the code that wrote it.
 */
export const archetypes = pgTable(
  "archetypes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    axis: categoryAxis("axis").notNull().default("function"),
    /** Category slug from `taxonomy/vocabulary.ts`. */
    category: text("category").notNull(),
    /** Monotonic per category. Version 1 is the first mine, never overwritten. */
    version: integer("version").notNull(),

    /**
     * The prescriptive part: ordered sections with per-section guidance, resource layout,
     * frontmatter and size norms. This is what the builder scaffolds from.
     */
    skeleton: jsonb("skeleton").notNull().default(sql`'{}'::jsonb`),
    /**
     * The evidence: prevalence in the strong band vs the weak band for every element,
     * plus the corpus counts the mine ran over. Every skeleton entry is traceable here.
     */
    stats: jsonb("stats").notNull().default(sql`'{}'::jsonb`),
    /** Structures correlated with *low* quality — guidance about what not to do. */
    antiPatterns: jsonb("anti_patterns").notNull().default(sql`'[]'::jsonb`),

    /** High-quality, licence-clean skills usable as in-context references (R3.3). */
    exemplarSkillIds: uuid("exemplar_skill_ids").array().notNull().default(sql`'{}'::uuid[]`),

    /** Skills the mine considered. */
    skillCount: integer("skill_count").notNull(),
    /** Distinct document structures among them — what the R3.2 gate is actually on. */
    distinctStructures: integer("distinct_structures").notNull(),
    /** Distinct sources they came from. A one-source archetype describes one author. */
    sourceCount: integer("source_count").notNull(),
    /** Quality score at the strong/weak band boundaries, for reproducibility. */
    strongThreshold: smallint("strong_threshold"),
    weakThreshold: smallint("weak_threshold"),

    /** Pinned so a regeneration is reproducible (R7.2). */
    extractorVersion: text("extractor_version").notNull(),
    minerVersion: text("miner_version").notNull(),
    taxonomyVersion: text("taxonomy_version").notNull(),

    /** What changed against the previous version, and why. Null on version 1. */
    changelog: text("changelog"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("archetypes_category_version_uq").on(t.orgId, t.axis, t.category, t.version),
    index("archetypes_category_idx").on(t.axis, t.category, t.version),
  ],
);
