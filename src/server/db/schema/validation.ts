import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skillVersions } from "./corpus";
import { verdictResult, verdictSeverity } from "./enums";

/**
 * The trust layer. Both tables are append-only.
 *
 * A verdict is never updated — it is superseded by a new row from a newer analyzer
 * version. That is what makes a re-scan campaign a targeted re-run instead of a
 * mutation, and what makes any past decision reproducible (Doc 2 R7.1, R7.2).
 */
export const verdicts = pgTable(
  "verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** Stable analyzer id, e.g. "structural-lint" or "prompt-injection". */
    analyzer: text("analyzer").notNull(),
    /** Bump on any rule change: it is the re-scan selector. */
    analyzerVersion: text("analyzer_version").notNull(),
    /** Model id when an LLM produced the verdict; NULL for rule-based analyzers. */
    modelId: text("model_id"),

    result: verdictResult("result").notNull(),
    severity: verdictSeverity("severity").notNull().default("info"),
    /** Machine-readable reason, e.g. "exfiltration-pattern", "hidden-instruction". */
    reason: text("reason"),
    /** Line-level findings, quoted payloads, scores. Rendered inert in the UI. */
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The common read: newest verdict per analyzer for a version. */
    index("verdicts_version_idx").on(t.skillVersionId, t.analyzer, t.createdAt),
    /** Re-scan selector: every version last judged by an older analyzer version. */
    index("verdicts_analyzer_idx").on(t.analyzer, t.analyzerVersion),
  ],
);

/**
 * What a skill can reach — file system, network, shell, credentials (Doc 2 R2.4).
 *
 * Captured per version so downstream consumers can reason about risk when combining
 * skills. The cross-skill composition analysis this enables is Phase 4; recording the
 * surface is P0 because it cannot be reconstructed later without re-fetching content we
 * may not be allowed to keep.
 */
export const capabilitySurfaces = pgTable(
  "capability_surfaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** Detector identity, so a surface can be re-derived and superseded like a verdict. */
    analyzer: text("analyzer").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),

    /** Structured capability flags plus the evidence for each. */
    surface: jsonb("surface").notNull().default(sql`'{}'::jsonb`),
    /** Capabilities the code has but the documentation never mentions (R2.3). */
    undocumented: text("undocumented").array(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("capability_surfaces_uq").on(
      t.skillVersionId,
      t.analyzer,
      t.analyzerVersion,
    ),
  ],
);
