import {
  index,
  integer,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills, skillVersions } from "./corpus";

/**
 * Near-duplicate detection (Doc 2 R1.4).
 *
 * Three tables because the three things have different lifetimes: a signature is derived
 * from content and dies with its version; a band is a lookup index into signatures; a
 * link is a *judgement* about two skills that a curator may want to see and override.
 */

/** One MinHash signature per skill version, tagged with the algorithm that made it. */
export const skillSignatures = pgTable(
  "skill_signatures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** Bump to invalidate and recompute, exactly like an analyzer version. */
    algorithm: text("algorithm").notNull().default("minhash"),
    algorithmVersion: text("algorithm_version").notNull(),

    signature: integer("signature").array().notNull(),
    shingleCount: integer("shingle_count").notNull(),
    /** Normalised prose length — a cheap sanity check on an empty or tiny document. */
    textLength: integer("text_length").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_signatures_uq").on(t.skillVersionId, t.algorithm, t.algorithmVersion),
  ],
);

/**
 * LSH bands: the equality-join index that makes similarity search scale.
 *
 * Candidate pairs are versions sharing any `(band_index, band_hash)`. Without this the
 * only option is all-pairs comparison, which is 125 billion pairs at the 500K target.
 */
export const skillSignatureBands = pgTable(
  "skill_signature_bands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    bandIndex: smallint("band_index").notNull(),
    bandHash: text("band_hash").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
  },
  (t) => [
    /** The lookup: everything sharing this band. */
    index("skill_signature_bands_lookup_idx").on(t.bandIndex, t.bandHash),
    uniqueIndex("skill_signature_bands_uq").on(
      t.skillVersionId,
      t.bandIndex,
      t.algorithmVersion,
    ),
  ],
);

/**
 * A confirmed near-duplicate relationship between two skills.
 *
 * Stored rather than recomputed because it is evidence: the similarity score and the
 * algorithm version behind a clustering decision are what let it be explained, appealed
 * and re-run. Attribution survives — both origins keep their own rows and their own
 * provenance (Doc 2 R1.4: "all sources remain attributed").
 */
export const skillDuplicates = pgTable(
  "skill_duplicates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    /** The retained entry. */
    canonicalSkillId: uuid("canonical_skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** The variant clustered under it. */
    duplicateSkillId: uuid("duplicate_skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    /** Exact Jaccard over shingles, not the MinHash estimate. */
    similarity: real("similarity").notNull(),
    /** MinHash estimate, kept to audit how well the estimator tracked the truth. */
    estimatedSimilarity: real("estimated_similarity"),
    algorithmVersion: text("algorithm_version").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_duplicates_uq").on(t.canonicalSkillId, t.duplicateSkillId),
    index("skill_duplicates_dup_idx").on(t.duplicateSkillId),
  ],
);
