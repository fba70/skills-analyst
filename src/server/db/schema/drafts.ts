import { sql } from "drizzle-orm";
import {
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

import { organization, user } from "./auth";
import { skills, skillVersions } from "./corpus";
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

    /* --------------------------------------------- imported (R5.6, plan step C6) */

    /**
     * Where this draft's starting document came from: `owned`, `forked` or `uploaded`.
     *
     * Null for a draft written here from a scaffold, which is every draft before C6. Absence is
     * the honest default rather than a fourth vocabulary value meaning "not imported" — a column
     * that is null when nothing happened cannot be misread as a claim.
     */
    importSource: text("import_source"),

    /**
     * The upstream version, for **live** resolution only.
     *
     * Its current name, and whether it has since been withdrawn, are things a reader should see
     * as they are now — the archetype-exemplar rule. `set null` on delete, because losing the
     * pointer must not delete the draft, and because the obligation does not live here.
     */
    importedFromVersionId: uuid("imported_from_version_id").references(() => skillVersions.id, {
      onDelete: "set null",
    }),

    /**
     * The licence obligation, **frozen** at import. An `Attribution` from `src/lib/improve.ts`.
     *
     * Duplicated out of the join columns on purpose, exactly as `takedowns` duplicates
     * `(source_url, skill_path)`: the record has to work when the rows it was recorded against
     * are gone. An attribution that vanishes because an upstream row was deleted is the failure
     * mode with legal consequences, and it is the one a live join would produce.
     *
     * Read by `publishDraft`, which inherits the posture and licence from it rather than writing
     * `authored` with a null licence — which is what the pre-C6 path would have done to a fork,
     * and would have been a lie.
     */
    importAttribution: jsonb("import_attribution"),

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

/**
 * A draft's typed blocks — the source the body is rendered from (Doc 6 RW.3, plan step C1).
 *
 * ## Why the draft stops being one string
 *
 * Interview mode, Distill, shared blocks, improve-an-existing-skill and agent-side creation
 * all operate on the *parts* of a document. Each is coherent over a list of typed spans and
 * incoherent over a body string, and building any of them against a string means rewriting
 * it later — which is why this step is the keystone of the plan rather than a refactor.
 *
 * The corpus has thought this way since A2: `skill_blocks` holds 1.6 million typed spans and
 * an archetype is a **block grammar**, not a heading list. A draft that cannot be compared
 * to that grammar at the same grain can only be advised about vaguely.
 *
 * ## `skill_drafts.body` stays, and is derived
 *
 * Publish-back (R6.1) and export (R4.4) take a body, hand it to the real validator and the
 * real archive builder, and never learn that blocks exist — that is exactly what makes those
 * two requirements true, and a block-aware export would be a second definition of
 * "servable". So the column stays a plain string and becomes a **render**, written only by
 * `setDraftBlocks` in the same transaction that writes these rows. Two writable
 * representations of one document drift, and the drift is invisible until somebody publishes
 * a document that is not the one they edited.
 *
 * ## Rows are replaced, never upserted
 *
 * Same reasoning as `skill_blocks`, arrived at from the other direction. There, the row
 * *count* changes when the rules change, so no key an upsert could target exists. Here the
 * count changes because the author inserted a block in the middle, and `block_order` is in a
 * unique index — an in-place renumbering would collide with itself mid-statement. Deleting
 * the draft's rows and re-inserting the whole list in one transaction is correct for both
 * reasons and is trivially right, at the tens of rows a draft actually holds.
 *
 * Ids are **supplied by the caller** on a replace, so identity survives it. That is not
 * tidiness: C2b attaches an accept/reject decision to a block and D1 attaches an eval case,
 * and neither can hang off a row whose id changes every time the author reorders something.
 *
 * ## `text` holds the author's own words, and that is the difference from `skill_blocks`
 *
 * `skill_blocks` may never grow a column holding body text — it stores `[startChar, endChar)`
 * into somebody else's document, and the licence gate applies at the moment of reading. This
 * table is the opposite case: the content is the author's, in their own workspace, and there
 * is no bundle to slice into because the document does not exist until these rows render it.
 * Storing an offset here would be an offset into a string derived from the rows themselves.
 */
export const draftBlocks = pgTable(
  "draft_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Denormalised from the draft, because RLS needs it on the row.
     *
     * A policy that had to join `skill_drafts` to find the organisation would be a policy
     * evaluated per row against another table whose own policy is being evaluated. NOT NULL
     * with no `IS NULL` escape hatch, matching the parent: there is no such thing as a
     * public draft, so there is no such thing as a public draft block.
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),

    /** Position in the document, 0-based and contiguous. */
    blockOrder: smallint("block_order").notNull(),

    /**
     * `heading` or `content` — see `DRAFT_BLOCK_FORMS`.
     *
     * A heading is a block *here* and nowhere else. The corpus extractor treats it as a
     * boundary, correctly, because it is already the fingerprint's own unit and emitting it
     * twice would double-count every section. A draft reassembled from typed spans alone
     * comes back with every heading gone, so the draft's list has to tile the document.
     */
    form: text("form").notNull(),

    /** 1–6 for a heading; NULL for content. */
    depth: smallint("depth"),

    /**
     * One of `BLOCK_TYPES`, or NULL when the author has not said and no rule recognised it.
     *
     * Nullable for the same reason the corpus column is: Doc 6 §7 names over-structuring as
     * this programme's risk, and a workbench that would not hold a paragraph until somebody
     * labelled it would be that risk arriving. 59% of the corpus's blocks are untyped.
     */
    type: text("type"),

    /** The author's markdown. For a heading, the label alone, without its `#` marks. */
    text: text("text").notNull(),

    /**
     * The shared convention this block was pulled from (RK.4, plan step E6). Null for ordinary
     * blocks, which is nearly all of them.
     *
     * The block keeps **its own copy of the text** beside this pointer, deliberately, and that is
     * the opposite of how every other pointer in this schema resolves. Two reasons, in
     * `src/lib/shared-blocks.ts` at length: the body is a render of these rows and must not depend
     * on a second table, and live substitution rewrites somebody's document in the middle of
     * sentences they wrote with nothing in any history saying so.
     *
     * `set null` on delete rather than cascade — losing the convention must never delete the
     * author's paragraph. In practice a shared block is retired rather than deleted.
     */
    sharedBlockId: uuid("shared_block_id").references(() => sharedBlocks.id, {
      onDelete: "set null",
    }),
    /** Which version of it was pulled. Behind the shared block's own version means an update waits. */
    sharedBlockVersion: integer("shared_block_version"),

    /**
     * The structure behind a `decision-rule` block (Doc 7 RD.2, plan step P4). A `BlockRule` from
     * `src/lib/parameters.ts`: rows of conditions over the draft's parameters and an action in
     * the author's words, plus the hash of the text those rows rendered to. Null for every block
     * that is prose, which is nearly all of them.
     *
     * On the block it describes rather than in a second table, so the two cannot disagree about
     * which passage the structure belongs to. **Never on `skill_blocks`**, which stores offsets
     * and no content — a corpus skill's structure is re-derived, not stored.
     *
     * The text stays the author's. When it no longer hashes to `renderHash` the structure is
     * *out of date* and is shown as such; nothing re-renders a sentence somebody edited.
     */
    rule: jsonb("rule"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * One index, not two. It is unique because `block_order` is contiguous within a draft,
     * and it is also the ordered read path — a second plain btree on the same two columns in
     * the same order is dead weight the planner would never choose.
     */
    uniqueIndex("draft_blocks_uq").on(t.draftId, t.blockOrder),

    /**
     * Tenant isolation, declared on the table so drizzle-kit generates it (Doc 3 C4).
     *
     * No `org_id IS NULL` clause, exactly as `skill_drafts` has none: the column is NOT NULL
     * and there is no anonymous case to admit. An unauthenticated request sets no
     * `app.org_id`, `current_setting` returns NULL, the comparison yields NULL rather than
     * true, and no rows come back — which is the correct answer.
     *
     * `FOR ALL` includes DELETE, and it has to: a save replaces the draft's rows.
     *
     * No GRANT is written and none is needed — migration 0002's default privileges cover
     * every table a later migration creates.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * Draft revisions (Doc 2 R4.7) — the history a block model makes worth keeping.
 *
 * ## Why this arrives with C1 and could not have arrived before it
 *
 * R4.7 has been open since the builder shipped, and the reason it stayed open is that a
 * revision over a body string is a character diff. Nobody reads one of those as a decision:
 * "3,412 characters changed" says nothing about whether a guardrail was removed. Over blocks
 * it is a list an author can read — this block was added, that one was retyped from
 * `procedure` to `guardrail`, this one moved above the examples — and each of those is a
 * sentence about the document rather than about the text.
 *
 * That only works because `setDraftBlocks` carries block ids through a replace. A revision
 * diff matches on id: without it every reorder would read as delete-everything-add-everything,
 * which is the character diff again wearing a list's clothes.
 *
 * ## A snapshot, not rows
 *
 * `draft_blocks` is the working copy and is replaced on every save; this is immutable
 * history, read whole and never queried by block. A second table shaped like the first would
 * be a join for something nothing joins on. Same call `skill_drafts.validation` and
 * `scaffold_sections` already make.
 *
 * The body is **not** stored beside it, deliberately. A revision is a set of blocks, and the
 * body is what the renderer makes of them — storing both would reintroduce, inside the
 * history, the exact drift the live table was designed to prevent.
 *
 * ## Append-only, and there is no DELETE policy
 *
 * History that the application can rewrite is not history. Same posture as `llm_usage` and
 * `platform_settings`: the row is written and never removed, and maintenance — if a draft
 * ever accumulates enough revisions to matter — goes through the owner connection that
 * migrations already use. A cascade from `skill_drafts` still works: PostgreSQL runs a
 * referential action as an internal operation and does not apply the policy to it, so
 * deleting a draft still takes its history with it.
 *
 * No retention cap in this version, stated rather than left to be discovered. A draft is
 * saved tens of times, not thousands, and a cap chosen before anybody has seen the real
 * distribution is a number that will be wrong in one direction or the other.
 */
export const draftRevisions = pgTable(
  "draft_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Denormalised for RLS, exactly as on `draft_blocks`. */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),

    /** 1-based and contiguous per draft, so a person can refer to "revision 4". */
    revision: integer("revision").notNull(),

    /**
     * The block list as it stood, in order: `{ id, form, depth, type, text }`.
     *
     * Ids are part of the snapshot and are the whole reason the diff is readable — a block
     * that only moved is recognisably the same block.
     */
    blocks: jsonb("blocks").notNull(),

    /**
     * What produced this revision, from a closed vocabulary — `generated`, `scaffolded`,
     * `edited`, `restored`. A column rather than free text because it is the thing a history
     * list groups and filters by, and because "the model wrote this one" and "a person wrote
     * this one" is the distinction anyone reading the list is actually looking for.
     */
    reason: text("reason").notNull(),
    /** Free detail beside the reason — which revision a restore came from, for instance. */
    note: text("note"),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("draft_revisions_uq").on(t.draftId, t.revision),

    /**
     * SELECT and INSERT, org-scoped. No UPDATE and no DELETE, and the absence is the point:
     * a revision that could be edited is not a revision. No `IS NULL` escape hatch, matching
     * the parent — there is no public draft, so there is no public draft history.
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

/**
 * The files a draft holds beside its marker (R5.6, plan step C6).
 *
 * ## Why a draft needed to learn about files at all
 *
 * A draft was one document, and that was right while every draft started from a scaffold. C6
 * starts from a skill that already exists, and a real skill is a **bundle** — `references/`,
 * `scripts/`, sometimes more. Importing one and keeping only the marker would silently discard
 * the half the archetype rewards most: the miner measures *links to its own bundled files* at
 * +23 and *offloads detail into `references/`* at +12 to +26.
 *
 * It also unblocks the half of C5 that could not be built. RW.11 computes which blocks should
 * move into `references/` and had nowhere to write them; this is the somewhere.
 *
 * ## Text in a column, not bytes in a bucket
 *
 * Object storage is where *published* bundles live, content-addressed at the hash a verdict
 * covers. A draft is none of that: it is mutable, private, measured in kilobytes, and deleted
 * when its author deletes it. Putting it in R2 would buy an orphaned-object lifecycle and a
 * second place tenant data lives, in exchange for nothing — so it is a `text` column under the
 * same org-scoped policy as the draft itself, with `MAX_RESOURCE_BYTES` keeping that honest.
 *
 * Binary is refused rather than mangled: `looksBinary` checks the bytes rather than the
 * extension, because an extension is a guess about a filename and a NUL byte is a fact.
 */
export const draftResources = pgTable(
  "draft_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** NOT NULL and no `IS NULL` escape in the policy, exactly as on the draft itself. */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),

    /** Relative, normalised by `safeResourcePath`. Never absolute, never climbing out. */
    path: text("path").notNull(),
    content: text("content").notNull(),
    byteSize: integer("byte_size").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One file per path per draft. The upsert target for an edit and for a re-import. */
    uniqueIndex("draft_resources_uq").on(t.draftId, t.path),
    index("draft_resources_draft_idx").on(t.draftId),

    /**
     * The `skill_drafts` policy verbatim, including its strictness.
     *
     * There is no such thing as a public draft, so there is no such thing as a public draft
     * file, and a request with no session sees nothing rather than seeing "the public ones".
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * Organisation convention blocks (Doc 6 RK.4, plan step E6) — Team.
 *
 * ## Versioned, because the version is what makes a dependent legible
 *
 * `version` bumps on every text change, and a draft block records which one it took. That single
 * integer is the whole update mechanism: `block.shared_block_version < shared.version` means an
 * update is waiting, and it is answerable without diffing text or storing a history of it.
 *
 * ## Retired, not deleted
 *
 * A convention that fifty drafts point at cannot simply go away — the pointer would null and the
 * authors would never learn why their block stopped tracking anything. `retired_at` keeps the row
 * readable, keeps every dependent's copy intact, and stops it being added to anything new. Same
 * decision as a withdrawn maintainer standing and a rejected flag: the record is the point.
 *
 * ## Org-scoped with no public escape, and never near an archetype
 *
 * *"Our incident-severity definitions"* is exactly the private organisational knowledge RC.5 and
 * OQ-C2 forbid feeding public archetypes even in aggregate. The policy has no `org_id is null`
 * branch, like `skill_drafts`, because there is no such thing as a public convention — and
 * `mineArchetype` reads `builder_signals`, which carries a section role and a boolean and has
 * never been able to reach this table.
 */
export const sharedBlocks = pgTable(
  "shared_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** What somebody types to find it. Unique per organisation, case-folded. */
    name: text("name").notNull(),
    /** One of `BLOCK_TYPES`. Never null — an untyped convention cannot be compared to anything. */
    type: text("type").notNull(),
    text: text("text").notNull(),
    /** Why this convention exists, for the person deciding whether to use it. */
    note: text("note"),

    /** Bumped on every text change. A dependent behind this number has an update waiting. */
    version: integer("version").notNull().default(1),

    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One convention per name per workspace, folded.
     *
     * Case-insensitive for the reason the repository-identity indexes are: two rows differing
     * only in capitalisation are one convention and a bug, and the person who typed the second
     * would never find out.
     */
    uniqueIndex("shared_blocks_name_uq").on(t.orgId, sql`lower(${t.name})`),
    index("shared_blocks_org_idx").on(t.orgId, t.retiredAt),

    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * A draft's declared parameters (Doc 7 RD.1, plan step P4).
 *
 * ## A taxonomy local to the skill
 *
 * `function` and `domain` are the platform's closed vocabularies; a parameter is the author's —
 * `environment`, `severity`, `change size` — the named things this one skill's rules branch on.
 * It has a kind, and for an enum the closed set of values, which is the denominator coverage is
 * measured against. A parameter with kind `enum` and no values is refused: there would be nothing
 * to measure, and *not measurable* is a different sentence from *0%*.
 *
 * ## Candidates live here too, with a decision
 *
 * A parameter the model read out of the draft's own decision rules arrives `detected` and
 * `pending`; the author accepts, renames or rejects it. Declared ones are `accepted` on arrival.
 * A rejected candidate is **kept**, for the reason a rejected interview candidate is: a source
 * whose suggestions are always rejected is only prunable if the rejections exist.
 *
 * ## In the document as a table, through the one writer
 *
 * The accepted parameters render as a glossary table in the body. That render goes through
 * `setDraftBlocks` as an ordinary block, never through a second render path — `skill_drafts.body`
 * keeps its single writer, and `verify:draft-blocks` keeps asserting so.
 *
 * Org-scoped with no `IS NULL` escape, exactly as the draft itself: there is no such thing as a
 * public draft, so there is no public parameter.
 */
export const draftParameters = pgTable(
  "draft_parameters",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Denormalised for RLS, exactly as on `draft_blocks`. */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),

    /** What the rules call it. Unique per draft, case-folded. */
    name: text("name").notNull(),
    /** One of `PARAMETER_KINDS`. */
    kind: text("kind").notNull(),
    /** The closed set for an enum; `[]` for every other kind. */
    values: jsonb("values").notNull().default(sql`'[]'::jsonb`),
    unit: text("unit"),
    /** One line: what this parameter means to the skill. Rendered in the glossary table. */
    meaning: text("meaning"),

    /** One of `PARAMETER_SOURCES` — who put it here. */
    source: text("source").notNull().default("declared"),
    /** One of `PARAMETER_DECISIONS`. A declared parameter is accepted on arrival. */
    decision: text("decision").notNull().default("accepted"),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One parameter per name per draft, folded — `Environment` and `environment` are one thing,
     * and the second person to type it would otherwise never find out. The repository-identity
     * fold, one layer up, as on `shared_blocks`.
     */
    uniqueIndex("draft_parameters_name_uq").on(t.draftId, sql`lower(${t.name})`),
    index("draft_parameters_draft_idx").on(t.draftId),

    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
