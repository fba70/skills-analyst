import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import {
  licenseSource,
  redistributionPosture,
  signalKind,
  skillDialect,
  skillStatus,
  skillVersionStatus,
  sourceHealth,
  sourceKind,
} from "./enums";

/**
 * The corpus.
 *
 * `org_id` is NULL for the public corpus and set for a tenant's private one. It is
 * denormalised onto every org-scoped table on purpose: RLS policies compare a column to
 * one session setting, with no joins, which is what keeps the backstop cheap enough to
 * leave on. Note it is `text`, not `uuid` — Better Auth owns `organization.id` and types
 * it as text (Doc 3 assumed uuid).
 */

const orgId = () =>
  text("org_id").references(() => organization.id, { onDelete: "cascade" });

/** Where skills come from. Cadence is data, not a deploy (Doc 3). */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    kind: sourceKind("kind").notNull(),
    /** Human label, e.g. "anthropics/skills". */
    name: text("name").notNull(),
    /** Canonical upstream location; unique per org so a repo is not added twice. */
    url: text("url").notNull(),
    /** Connector-specific settings: ref, path filters, search shards. */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    health: sourceHealth("health").notNull().default("unknown"),
    healthDetail: jsonb("health_detail"),
    /** Cron expression. NULL means manual runs only — Phase 1 is all manual. */
    schedule: text("schedule"),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    /** Resumable-crawl bookmark: shard cursor, ETag, last commit seen. */
    cursor: jsonb("cursor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sources_org_url_uq").on(t.orgId, t.url),
    /**
     * One public source per URL — the constraint everyone assumed the line above was
     * already enforcing.
     *
     * It was not. Postgres treats NULLs as **distinct** in a unique index, and `org_id` is
     * NULL for every public source, so `(NULL, url)` never collided with `(NULL, url)`.
     * The whole public corpus was unconstrained: `VoltAgent/awesome-agent-skills` reached
     * three rows, and `promote()` had grown a hand-rolled select-then-insert to work
     * around a guarantee that did not exist.
     *
     * A partial index rather than `NULLS NOT DISTINCT` because this drizzle version cannot
     * express the latter, and because the partial form states the rule in the terms the
     * codebase actually uses: `org_id IS NULL` *is* the public corpus.
     */
    uniqueIndex("sources_public_url_uq")
      .on(t.url)
      .where(sql`${t.orgId} is null`),
    index("sources_enabled_idx").on(t.enabled, t.health),
  ],
);

/**
 * A skill, deduplicated across sources. Near-duplicates cluster under one canonical
 * entry via `canonicalSkillId`, and every origin stays attributed through its versions.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    /** Self-reference: NULL means this row is the canonical one. */
    canonicalSkillId: uuid("canonical_skill_id"),
    dialect: skillDialect("dialect").notNull().default("unknown"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary"),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    status: skillStatus("status").notNull().default("pending"),
    /** Composite 0–100 (Doc 2 R2.9). NULL until first scored. */
    qualityScore: smallint("quality_score"),
    /** The version currently served. NULL while a skill has never passed validation. */
    currentVersionId: uuid("current_version_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Self-reference for the duplicate cluster; declared here to break the cycle. */
    foreignKey({
      columns: [t.canonicalSkillId],
      foreignColumns: [t.id],
      name: "skills_canonical_skill_id_fk",
    }).onDelete("set null"),
    uniqueIndex("skills_org_slug_uq").on(t.orgId, t.slug),
    index("skills_status_idx").on(t.status),
    index("skills_canonical_idx").on(t.canonicalSkillId),
    index("skills_categories_idx").using("gin", t.categories),
  ],
);

/**
 * An immutable snapshot of a skill at one upstream commit.
 *
 * `contentHash` is the identity: storage keys are content-addressed, so the key *is* the
 * hash the verdict covers and integrity is structural rather than checked.
 */
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),

    /** sha256 over the normalised bundle. */
    contentHash: text("content_hash").notNull(),
    /** Content-addressed object key, NULL when the licence forbids mirroring. */
    storageKey: text("storage_key"),
    contentStored: boolean("content_stored").notNull().default(false),
    byteSize: bigint("byte_size", { mode: "number" }),
    fileCount: integer("file_count"),

    /** Parsed YAML frontmatter, dialect-normalised. */
    frontmatter: jsonb("frontmatter").notNull().default(sql`'{}'::jsonb`),
    /** repo, path, commit sha, author(s), fetched-at, per-file hashes. */
    provenance: jsonb("provenance").notNull(),

    /** SPDX expression, e.g. "MIT" or "Apache-2.0 OR MIT". NULL when unresolved. */
    licenseSpdx: text("license_spdx"),
    licenseSource: licenseSource("license_source").notNull().default("unresolved"),
    /** Which file/API answered, and what it said — the audit trail for the decision. */
    licenseEvidence: jsonb("license_evidence"),
    /** The gate: analysis always allowed, mirroring only when this permits it. */
    redistribution: redistributionPosture("redistribution").notNull().default("unresolved"),

    status: skillVersionStatus("status").notNull().default("pending"),
    /** Machine-readable quarantine reasons, e.g. ["exfiltration-pattern"]. */
    quarantineReasons: text("quarantine_reasons").array(),

    upstreamRef: text("upstream_ref"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Dedup (Doc 2 R1.4): the same bytes from two sources collapse to one row. Partial,
     * because a tombstoned version must not block the same content reappearing later.
     */
    uniqueIndex("skill_versions_content_hash_uq")
      .on(t.contentHash)
      .where(sql`status <> 'tombstoned'`),
    index("skill_versions_skill_idx").on(t.skillId, t.syncedAt),
    index("skill_versions_source_idx").on(t.sourceId),
    index("skill_versions_status_idx").on(t.status),
  ],
);

/**
 * Upstream popularity over time — stars, forks, downloads (Doc 2 R1.3, R2.9, R3.5).
 *
 * Append-only rather than a column on `skills`: a single overwritten number answers "how
 * popular is this now", but the loop needs "how did this change", which only a series can
 * answer.
 */
export const skillSignals = pgTable(
  "skill_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    kind: signalKind("kind").notNull(),
    value: numeric("value", { precision: 20, scale: 4 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_signals_lookup_idx").on(t.skillId, t.kind, t.observedAt),
    /** One reading per skill/source/kind/timestamp — re-runs are idempotent. */
    uniqueIndex("skill_signals_uq").on(t.skillId, t.sourceId, t.kind, t.observedAt),
  ],
);
