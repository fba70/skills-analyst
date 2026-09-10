import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgPolicy,
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

    // ---- Tool references (Doc 7 RD.6, extractor 2.1.0) -----------------------
    /**
     * `{ gh: 3, git: 5, "scripts/run.py": 1 }` — commands the body tells an agent to run.
     *
     * Candidate tokens with counts, **not** vocabulary entries: Doc 7 §4 says the tool
     * vocabulary is seeded from this table rather than typed from memory, so the column has
     * to hold whatever the corpus actually says. jsonb like `blockCounts`, for the same
     * reason — the question asked of it is "how often does this token appear corpus-wide",
     * which is one `jsonb_each` over the rows at the current extractor version.
     */
    toolRefs: jsonb("tool_refs")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** `allowed-tools` from the frontmatter, kept apart so RD.8 can compare it to the prose. */
    allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`),
    /** `[{ tool: "next", version: "15" }]` — what the prose pins, for RD.10's drift check. */
    versionPins: jsonb("version_pins")
      .$type<Array<{ tool: string; version: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    // ---- Blocks (Doc 6 RW.1) -----------------------------------------------
    /**
     * Which marker file the body and every block span index into.
     *
     * Stored rather than re-derived, because a block span is only meaningful against one
     * exact string. The loader currently finds the marker with a regex over the bundle;
     * pinning the answer here means a later change to that regex cannot silently
     * re-point a million stored spans at a different file.
     */
    markerPath: text("marker_path"),
    /**
     * Distinct block types present, deduplicated — the indexable aggregation path.
     *
     * Sits here for exactly the reason `sectionRoles` does. Mining asks "does this
     * structure carry a guardrail" across tens of thousands of rows, and answering that
     * by unnesting `skill_blocks` on every query is the shape that made `/skills` take
     * 2.3 seconds. `skill_blocks` holds the detail; this holds the answer.
     */
    blockTypes: text("block_types").array().notNull().default(sql`'{}'::text[]`),
    /** `{ guardrail: 3, procedure: 1, unclassified: 4 }` — density, not just presence. */
    blockCounts: jsonb("block_counts").notNull().default(sql`'{}'::jsonb`),
    blockCount: integer("block_count").notNull().default(0),
    /**
     * Estimated context cost of the whole body, in tokens (Doc 6 RW.9, measurement half).
     *
     * An estimate and named as one: four characters to the token for prose, three for
     * code. A real tokenizer is a dependency this project has not taken, so RW.9's
     * headline claim ("this skill costs 4.2K tokens per activation") stays A3's problem
     * and this stays the free approximation that makes the number visible at all.
     */
    tokenEstimate: integer("token_estimate").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One fingerprint per version per extractor version — re-extraction supersedes by
    // upsert rather than piling up rows, because unlike a verdict a fingerprint carries
    // no judgement worth keeping history of.
    uniqueIndex("skill_structures_uq").on(t.skillVersionId, t.extractorVersion),
    index("skill_structures_skill_idx").on(t.skillId),
    index("skill_structures_roles_idx").using("gin", t.sectionRoles),
    index("skill_structures_blocks_idx").using("gin", t.blockTypes),
  ],
);

/**
 * One typed span per functional unit of a skill body (Doc 6 RW.1 / RW.2).
 *
 * ## Why a table and not more jsonb on the row above
 *
 * `headings` is jsonb because nothing ever asks for *a heading* — only for the shape of a
 * document. Blocks are asked for individually: the compose step wants "the three best
 * guardrail blocks in this category, attributed", and conflict detection (RK.3) wants to
 * compare one skill's guardrails against another's. Both are `select … where type = …
 * order by quality` across the corpus, which is a table with an index, not an unnest of
 * fifty thousand jsonb arrays.
 *
 * ## A row is a coordinate, never content
 *
 * `start_char`/`end_char` index into the marker body named by `skill_structures.marker_path`,
 * whose bytes live under the content hash. That is the whole reason a block library can
 * exist for a `metadata_only` skill: the row says *where* a guardrail is, and reading it
 * requires the bundle, which is behind the licence gate (R1.6). A fragment therefore
 * resolves live, exactly as an archetype exemplar does — and inherits the same property
 * that a skill withdrawn since extraction stops being quotable the moment it is withdrawn,
 * rather than living on in a stored copy.
 *
 * **This table may never grow a column holding body text.** It is the same
 * safe-because-of-the-column-list argument the `builder_signals` read policy rests on, and
 * `verify:blocks` asserts it against `information_schema` rather than against the current
 * data, because data being clean today says nothing about the next migration.
 *
 * ## Derived, so replaced rather than versioned
 *
 * Re-extraction at the same extractor version deletes this version's rows and re-inserts
 * them, because the block *count* changes and an upsert cannot express that. Unlike a
 * verdict, a block carries no judgement worth keeping history of — the same reasoning that
 * makes the fingerprint above an upsert. A new extractor version writes new rows and
 * leaves the old ones, which is what makes an extractor bump comparable.
 */
export const skillBlocks = pgTable(
  "skill_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    /** Denormalised from the version so the library can rank without a second join. */
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    extractorVersion: text("extractor_version").notNull(),

    /** Position in the document, 0-based, over every segment including unclassified ones. */
    blockOrder: smallint("block_order").notNull(),
    /**
     * One of `BLOCK_TYPES`, or NULL when no rule recognised the passage.
     *
     * Nullable on purpose. Doc 6 §7 names over-structuring as this programme's risk, so an
     * unrecognised passage stays valid content rather than being forced into the nearest
     * type — the same posture the heading rules already take with genuinely topical
     * headings. The unclassified share is the honest measure of whether this vocabulary is
     * recognising or guessing, and it can only be measured if these rows exist.
     */
    type: text("type"),
    /** Which detector rule fired, from a closed vocabulary — so a rejection leaves a trace. */
    rule: text("rule"),

    /** Role of the enclosing heading; NULL for the preamble above the first heading. */
    parentRole: text("parent_role"),
    /** Index into `skill_structures.headings`, so a block traces back to its section. */
    parentHeadingOrder: smallint("parent_heading_order"),

    startChar: integer("start_char").notNull(),
    endChar: integer("end_char").notNull(),

    /** Estimated context cost of this block alone. See the note on the column above. */
    tokenEstimate: integer("token_estimate").notNull().default(0),
    /** Segment shape: paragraph, list, code, table, quote. A column because it aggregates. */
    kind: text("kind").notNull(),
    /** A column because fragment ranking needs it — a four-word guardrail is not an exemplar. */
    wordCount: integer("word_count").notNull().default(0),
    /** `{ itemCount, ordered, codeLanguage, linkCount, hasModal, hasConditional, ... }`. */
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_blocks_uq").on(t.skillVersionId, t.extractorVersion, t.blockOrder),
    /** The library's query: every block of one type at the current extractor version. */
    index("skill_blocks_type_idx").on(t.extractorVersion, t.type),
    index("skill_blocks_skill_idx").on(t.skillId),

    /**
     * Tenant isolation, declared here so **drizzle-kit generates it** (Doc 3 C4).
     *
     * Every org-scoped table before this one had its policy hand-written into the generated
     * migration. That worked and it was a second source of truth: the schema said one thing,
     * a `.sql` file said another, and nothing could compare them. Declaring the policy on
     * the table means the ORM owns the whole object — columns, indexes *and* who may read a
     * row — and a policy can no longer be forgotten in a migration or drift from the model.
     *
     * In the same migration as the table by construction, which is the property migration
     * 0006 had to argue for in a comment: RLS defaults to deny, so a table whose policy
     * lands later has a window where `app_runtime` reads zero rows and the feature looks
     * broken rather than leaky.
     *
     * `org_id IS NULL` is the public corpus, which is every block the crawl produces today.
     * The clause is what keeps a Team-tier private skill's blocks inside its own tenant when
     * R1.9 lands, and it is RC.5 as well: a private skill's guardrails must never reach a
     * public archetype, not even as one row in a prevalence count.
     *
     * `FOR ALL` includes DELETE on purpose. Re-extraction *replaces* a version's blocks
     * rather than upserting them, because the row count changes when the rules change and
     * there is no key an upsert could target. Unlike a verdict, a block carries no judgement
     * worth keeping.
     *
     * No GRANT is needed and none is written: migration 0002 set
     * `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON
     * TABLES TO app_runtime`, so every table a migration creates is reachable. Migration
     * 0006 created `skill_structures` with no grant and mining has read it ever since, which
     * is the proof. The explicit grants in 0018–0020 are redundant belt-and-braces.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
