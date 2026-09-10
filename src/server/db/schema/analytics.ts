import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgPolicy,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
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

/**
 * One embedding per skill version (Doc 3 §Data model, unparking pgvector).
 *
 * ## Why this exists, and why now
 *
 * Four features are blocked on vector similarity and none of them can be built on text
 * matching: R3.6's "twelve similar skills exist, here is how yours differs" for an author,
 * RW.8's trigger-collision testing against a caller's other skills, RK.3's contradiction
 * detection between guardrails, and RK.5's clustering of what the corpus does not cover.
 *
 * It was deliberately parked until the corpus stopped moving, and the reasoning was sound:
 * vectors built over a half-ingested corpus get rebuilt. Ingestion finished, so the
 * condition is met.
 *
 * ## Derived, versioned, and re-buildable — like every other derived table here
 *
 * `embedder_version` pins the model, the dimension count *and* the text composition, which
 * is the part that would otherwise drift silently: change what goes into the prompt and the
 * vectors stop being comparable to each other while still being present, current-looking
 * rows. Same contract as `verdicts.analyzer_version` and `skill_structures.extractor_version`.
 *
 * `input_hash` is the cheap half of the same idea. A re-run skips a version whose composed
 * input is unchanged, so a backfill can be resumed, re-run, and interrupted without paying
 * twice — which matters here because unlike the extractor this one costs money.
 *
 * ## A vector is a measurement, not a copy
 *
 * Stored for `metadata_only` skills too, on the same reasoning as fingerprints: R1.6 forbids
 * mirroring content, not measuring it, and Doc 4 §5 step 6 permits "statistical/structural
 * features only, no reproduction". 1,536 floats are lossy in a way a hash is not, so this is
 * a judgement rather than an obvious call — but it is the same judgement the corpus already
 * makes for heading trees and block spans, and it is what makes similarity work across the
 * whole corpus rather than the servable slice.
 */
export const skillEmbeddings = pgTable(
  "skill_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    /** Denormalised, so a similarity query can rank without joining back to versions. */
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    /** Model + dimensions + text composition, as one string. The re-embed selector. */
    embedderVersion: text("embedder_version").notNull(),
    /** The gateway model id, stored separately so the spend ledger can be reconciled. */
    model: text("model").notNull(),
    /** sha256 of the composed input, so an unchanged version is never paid for twice. */
    inputHash: text("input_hash").notNull(),
    /** Tokens the provider charged for. Kept so a backfill's cost is auditable per row. */
    inputTokens: integer("input_tokens").notNull().default(0),

    /**
     * 1,536 dimensions: what `openai/text-embedding-3-small` returns natively, and the
     * ceiling Doc 3 sized this table for.
     *
     * Fixed in the column type, so a model change that returns a different width fails at
     * the insert rather than storing vectors that cannot be compared with the ones beside
     * them. That is the failure worth making loud: mixed-width vectors in one column are
     * silently meaningless, and the index would still answer queries.
     */
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_embeddings_uq").on(t.skillVersionId, t.embedderVersion),
    index("skill_embeddings_skill_idx").on(t.skillId),
    /**
     * HNSW with cosine distance.
     *
     * Cosine because these vectors are compared for *topical* similarity and the provider
     * returns them normalised, so cosine and inner product rank identically while cosine
     * keeps distances in a range a human can read in a debug query.
     *
     * HNSW rather than IVFFlat: it needs no training pass over existing rows, which means
     * the index is correct from the first insert instead of degrading until somebody
     * remembers to rebuild it after a backfill. Costlier to build, and 48k rows is nowhere
     * near where that matters.
     */
    index("skill_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),

    /** Org-scoped, generated by drizzle-kit — the convention set on 2026-09-06. */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);

/**
 * What somebody is watching (Doc 2 R8.7, plan step F5).
 *
 * ## One row per watch, and no notification rows at all
 *
 * There is deliberately no `notifications` table. A materialised row per watcher per event needs
 * a fan-out job — one more thing that can fail silently — plus a dedup rule and a second copy of
 * what `events` already holds. What is stored instead is **what you watch and when you last
 * looked**, and the feed is a query over events since that timestamp.
 *
 * That also means a watch created today can show last month's history, because the events were
 * never the missing part. A materialised design would have to backfill to achieve the same, and
 * would look empty if somebody forgot.
 *
 * ## Keyed on the user, not the workspace
 *
 * A watch is a person's attention, not a workspace's policy. Two people in one organisation
 * watching different skills is the normal case, and an org-keyed row would make one of them
 * unsubscribe the other. `org_id` is absent for the same reason: there is nothing here that
 * belongs to a tenant.
 */
export const skillWatches = pgTable(
  "skill_watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** `skill` or `category` — one of `WATCH_SUBJECTS`. */
    subjectType: text("subject_type").notNull(),
    /** A skill id, or an `axis:value` category key. */
    subjectId: text("subject_id").notNull(),

    /**
     * When this watcher last read the feed for this watch.
     *
     * The whole unread mechanism, in one column. Set to the watch's creation time on subscribe
     * minus the backfill window, so a new watch opens with recent history rather than with
     * nothing — a feed that is empty on the day you subscribe teaches people it does not work.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One watch per person per thing. Pressing the button twice is not two subscriptions. */
    uniqueIndex("skill_watches_uq").on(t.userId, t.subjectType, t.subjectId),
    /** Every read: this person's watches. */
    index("skill_watches_user_idx").on(t.userId),

    /**
     * Keyed on the user, so the policy is the user's own rows — and `app.org_id` is the wrong
     * scope for it. There is no tenant here: a watch is a person's attention.
     *
     * Open to `app_runtime` and filtered by the caller, which is the honest shape when the
     * identity RLS would need is a user rather than an organisation. Safe because of the column
     * list: a user id, a subject, two timestamps. Every read goes through a function that already
     * resolved the session.
     */
    pgPolicy("all_access", {
      for: "all",
      to: "app_runtime",
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);
