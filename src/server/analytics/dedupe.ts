import "server-only";

import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  events,
  skillDuplicates,
  skills,
  skillSignatureBands,
  skillSignatures,
  skillVersions,
} from "@/server/db/schema";
import { splitFrontmatter } from "@/server/skills/normalize";
import { loadBundle, type VersionProvenance } from "@/server/validation/bundle-loader";

import {
  BAND_COUNT,
  bandHashes,
  estimateSimilarity,
  jaccard,
  minhashSignature,
  normalizeForComparison,
  shingles,
} from "./minhash";

/**
 * Clustering near-duplicate skills.
 *
 * Two passes, separable on purpose:
 *   1. **signature** — read each bundle once, store a MinHash signature and its LSH bands.
 *      This is the expensive half (it fetches content) and is resumable.
 *   2. **cluster** — LSH candidate generation is pure SQL over stored bands, but
 *      confirming a candidate needs the exact Jaccard, and that needs the text. So this
 *      pass re-reads the bundles of candidate members (cached within a run).
 *
 * Exact verification is kept rather than trusting the MinHash estimate, which carries ~9%
 * standard error at 128 permutations — enough to misplace borderline pairs in a product
 * whose claim is trustworthiness. The cost is that clustering is bounded work, not free.
 */

export const ALGORITHM_VERSION = "1.0.0";

/**
 * The clustering *rule*, versioned separately from the signature algorithm.
 *
 * Signatures are unchanged when only the decision changes, so bumping this re-clusters
 * without re-reading a single bundle — the whole reason the two passes are separate.
 */
export const CLUSTER_RULE_VERSION = "1.1.0";

/**
 * Jaccard above which two skills are the same skill.
 *
 * Doc 2 R1.4 says "≥90%-similar bodies". Verified exactly rather than trusted from the
 * MinHash estimate, because the estimate carries ~9% standard error at 128 permutations —
 * enough to misplace a borderline pair either way.
 */
export const SIMILARITY_THRESHOLD = 0.9;

/**
 * Descriptions must also agree.
 *
 * Body similarity alone was wrong on a whole class of real skills: template-generated
 * ones. `pm-claude-skills` ships dozens built from one scaffold — `roommate-agreement`,
 * `voting-navigator`, `clone-brief` — whose bodies are 94.3% identical boilerplate and
 * whose purposes are unrelated. Clustering them hid 66 distinct skills behind a template
 * file.
 *
 * The description is the one field that must differ for two skills to be different, since
 * it is what decides when each triggers. A lower bar than the body: descriptions are
 * short, so a few shared words move the number a lot.
 */
export const DESCRIPTION_THRESHOLD = 0.5;

/** Word-level Jaccard over descriptions. */
function describeSimilarity(a: string | null, b: string | null): number {
  const tokens = (value: string | null) =>
    new Set(
      normalizeForComparison(value ?? "")
        .split(" ")
        .filter((word) => word.length > 2),
    );
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  return jaccard(setA, setB);
}

export type SignatureReport = {
  processed: number;
  skipped: number;
  failed: number;
};

/** Pass 1: compute and store signatures for versions that do not have one. */
export async function buildSignatures(options: { limit?: number; onProgress?: (m: string) => void } = {}) {
  const log = options.onProgress ?? (() => {});
  const report: SignatureReport = { processed: 0, skipped: 0, failed: 0 };

  const existing = db
    .select({ id: skillSignatures.skillVersionId })
    .from(skillSignatures)
    .where(eq(skillSignatures.algorithmVersion, ALGORITHM_VERSION));

  const targets = await db
    .select({
      id: skillVersions.id,
      orgId: skillVersions.orgId,
      skillId: skillVersions.skillId,
      contentHash: skillVersions.contentHash,
      contentStored: skillVersions.contentStored,
      provenance: skillVersions.provenance,
    })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.status, "indexed"),
        notInArray(skillVersions.id, existing),
      ),
    )
    .limit(options.limit ?? 500);

  for (const version of targets) {
    try {
      const { files } = await loadBundle({
        contentStored: version.contentStored,
        contentHash: version.contentHash,
        tier: "public",
        provenance: version.provenance as VersionProvenance,
      });

      const marker = files.find((file) => /^(SKILL|AGENTS)\.md$/i.test(file.path)) ?? files[0];
      if (!marker) {
        report.skipped += 1;
        continue;
      }

      const { body } = splitFrontmatter(marker.content.toString("utf8"));
      const text = normalizeForComparison(body);
      const shingleSet = shingles(text);

      if (shingleSet.size === 0) {
        // Nothing to compare. Recorded as skipped rather than clustered with every other
        // empty document, which would be the worst possible false positive.
        report.skipped += 1;
        continue;
      }

      const signature = minhashSignature(shingleSet);
      const bands = bandHashes(signature);

      await db.transaction(async (tx) => {
        if (version.orgId) {
          await tx.execute(sql`select set_config('app.org_id', ${version.orgId}, true)`);
        }

        await tx
          .insert(skillSignatures)
          .values({
            orgId: version.orgId,
            skillVersionId: version.id,
            algorithmVersion: ALGORITHM_VERSION,
            signature,
            shingleCount: shingleSet.size,
            textLength: text.length,
          })
          .onConflictDoNothing();

        await tx
          .insert(skillSignatureBands)
          .values(
            bands.map((bandHash, bandIndex) => ({
              orgId: version.orgId,
              skillVersionId: version.id,
              skillId: version.skillId,
              bandIndex,
              bandHash,
              algorithmVersion: ALGORITHM_VERSION,
            })),
          )
          .onConflictDoNothing();
      });

      report.processed += 1;
      if (report.processed % 100 === 0) log(`  ${report.processed} signatures`);
    } catch {
      report.failed += 1;
    }
  }

  return report;
}

export type ClusterReport = {
  candidatePairs: number;
  confirmed: number;
  clusters: number;
  variantsMarked: number;
  /** Same body, different description — template siblings the body test alone accepted. */
  rejectedByDescription: number;
  /** True when a pair budget ran out before every candidate was verified. */
  stoppedEarly: boolean;
};

type CandidatePair = { a: string; b: string };

/**
 * Pass 2: find candidates via LSH, confirm them exactly, and cluster.
 *
 * Candidate generation is a self-join on `(band_index, band_hash)` — an equality join,
 * which is the only shape that survives corpus growth. All-pairs comparison at the 500K
 * target would be 125 billion pairs.
 */
export async function clusterDuplicates(
  options: { onProgress?: (m: string) => void; maxPairs?: number } = {},
) {
  const log = options.onProgress ?? (() => {});
  const report: ClusterReport = {
    candidatePairs: 0,
    confirmed: 0,
    clusters: 0,
    variantsMarked: 0,
    rejectedByDescription: 0,
    stoppedEarly: false,
  };

  const rows = await db.execute<{ a: string; b: string }>(sql`
    select distinct
      least(x.skill_version_id::text, y.skill_version_id::text) as a,
      greatest(x.skill_version_id::text, y.skill_version_id::text) as b
    from ${skillSignatureBands} x
    join ${skillSignatureBands} y
      on x.band_index = y.band_index
     and x.band_hash = y.band_hash
     and x.skill_version_id <> y.skill_version_id
     and x.skill_id <> y.skill_id
    where x.algorithm_version = ${ALGORITHM_VERSION}
      and y.algorithm_version = ${ALGORITHM_VERSION}
  `);

  // node-postgres returns a QueryResult, not an array — `.rows` holds the tuples.
  const pairs: CandidatePair[] = (rows.rows ?? []).map((row) => ({ a: row.a, b: row.b }));
  report.candidatePairs = pairs.length;
  log(`  ${pairs.length} candidate pair(s) from LSH`);

  if (pairs.length === 0) return report;

  // Signatures for everything involved, loaded once.
  const signatureRows = await db
    .select({
      versionId: skillSignatures.skillVersionId,
      signature: skillSignatures.signature,
      skillId: skillVersions.skillId,
      contentHash: skillVersions.contentHash,
      contentStored: skillVersions.contentStored,
      provenance: skillVersions.provenance,
      orgId: skillVersions.orgId,
      quality: skills.qualityScore,
      firstSeen: skills.firstSeenAt,
      summary: skills.summary,
    })
    .from(skillSignatures)
    .innerJoin(skillVersions, eq(skillVersions.id, skillSignatures.skillVersionId))
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .where(eq(skillSignatures.algorithmVersion, ALGORITHM_VERSION));

  const byVersion = new Map(signatureRows.map((row) => [row.versionId, row]));
  const shingleCache = new Map<string, Set<string>>();

  async function shinglesFor(versionId: string): Promise<Set<string> | null> {
    const cached = shingleCache.get(versionId);
    if (cached) return cached;
    const row = byVersion.get(versionId);
    if (!row) return null;

    const { files } = await loadBundle({
      contentStored: row.contentStored,
      contentHash: row.contentHash,
      tier: "public",
      provenance: row.provenance as VersionProvenance,
    });
    const marker = files.find((file) => /^(SKILL|AGENTS)\.md$/i.test(file.path)) ?? files[0];
    if (!marker) return null;

    const { body } = splitFrontmatter(marker.content.toString("utf8"));
    const set = shingles(normalizeForComparison(body));
    shingleCache.set(versionId, set);
    return set;
  }

  /** Union-find over skill ids: a duplicate of a duplicate belongs in the same cluster. */
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const seen = parent.get(id);
    if (!seen || seen === id) return id;
    const root = find(seen);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const confirmed: Array<{ a: string; b: string; similarity: number; estimate: number }> = [];

  const budget = options.maxPairs ?? Number.POSITIVE_INFINITY;
  let verified = 0;

  for (const pair of pairs) {
    // Verification reads content, so it is the part that has to be bounded.
    if (verified >= budget) {
      report.stoppedEarly = true;
      break;
    }
    const rowA = byVersion.get(pair.a);
    const rowB = byVersion.get(pair.b);
    if (!rowA || !rowB) continue;

    // Cheap gate first: the estimate rules out most candidates without reading content.
    const estimate = estimateSimilarity(rowA.signature, rowB.signature);
    if (estimate < SIMILARITY_THRESHOLD - 0.15) continue;

    const shinglesA = await shinglesFor(pair.a);
    const shinglesB = await shinglesFor(pair.b);
    verified += 1;
    if (!shinglesA || !shinglesB) continue;

    const similarity = jaccard(shinglesA, shinglesB);
    if (similarity < SIMILARITY_THRESHOLD) continue;

    // Same body, different purpose = template siblings, not duplicates.
    if (describeSimilarity(rowA.summary, rowB.summary) < DESCRIPTION_THRESHOLD) {
      report.rejectedByDescription += 1;
      continue;
    }

    confirmed.push({ a: rowA.skillId, b: rowB.skillId, similarity, estimate });
    parent.set(rowA.skillId, parent.get(rowA.skillId) ?? rowA.skillId);
    parent.set(rowB.skillId, parent.get(rowB.skillId) ?? rowB.skillId);
    union(rowA.skillId, rowB.skillId);
  }

  report.confirmed = confirmed.length;
  log(`  ${confirmed.length} pair(s) confirmed above ${SIMILARITY_THRESHOLD}`);

  // Group by cluster root, then pick the canonical entry per cluster.
  const clusters = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root)!.add(id);
  }
  report.clusters = clusters.size;

  const skillMeta = new Map(
    signatureRows.map((row) => [row.skillId, { quality: row.quality, firstSeen: row.firstSeen }]),
  );

  for (const members of clusters.values()) {
    if (members.size < 2) continue;

    /**
     * Canonical = highest quality, oldest as the tie-break.
     *
     * Not "first seen" alone: in a clone farm the original is often *not* the first thing
     * we happened to crawl, and quality is the signal that survives copying badly.
     */
    const canonical = [...members].sort((a, b) => {
      const metaA = skillMeta.get(a);
      const metaB = skillMeta.get(b);
      const qualityDiff = (metaB?.quality ?? 0) - (metaA?.quality ?? 0);
      if (qualityDiff !== 0) return qualityDiff;
      return (metaA?.firstSeen?.getTime() ?? 0) - (metaB?.firstSeen?.getTime() ?? 0);
    })[0];

    for (const member of members) {
      if (member === canonical) continue;

      const pair = confirmed.find(
        (entry) =>
          (entry.a === member && entry.b === canonical) ||
          (entry.b === member && entry.a === canonical),
      );

      await db.transaction(async (tx) => {
        await tx
          .insert(skillDuplicates)
          .values({
            canonicalSkillId: canonical,
            duplicateSkillId: member,
            similarity: pair?.similarity ?? SIMILARITY_THRESHOLD,
            estimatedSimilarity: pair?.estimate ?? null,
            algorithmVersion: CLUSTER_RULE_VERSION,
          })
          .onConflictDoNothing();

        // The variant keeps its own row, its own provenance and its own attribution —
        // it is linked, never deleted (Doc 2 R1.4).
        await tx
          .update(skills)
          .set({ canonicalSkillId: canonical, updatedAt: new Date() })
          .where(eq(skills.id, member));

        await tx.insert(events).values({
          actorType: "system",
          actorId: "dedupe",
          kind: "skill.clustered_as_variant",
          subjectType: "skills",
          subjectId: member,
          reason: `≥${SIMILARITY_THRESHOLD} similar to canonical`,
          payload: {
            canonicalSkillId: canonical,
            similarity: pair?.similarity ?? null,
            algorithmVersion: CLUSTER_RULE_VERSION,
          },
        });
      });

      report.variantsMarked += 1;
    }
  }

  return report;
}

/**
 * Withdraws every clustering decision, leaving signatures intact.
 *
 * Needed whenever the rule changes: a decision made under an old rule is not evidence for
 * the new one, and leaving it in place would mix two answers in one table.
 */
export async function resetClusters(): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx.delete(skillDuplicates).returning({ id: skillDuplicates.id });
    await tx
      .update(skills)
      .set({ canonicalSkillId: null })
      .where(sql`${skills.canonicalSkillId} is not null`);
    return removed.length;
  });
}

export async function duplicateSummary() {
  const [counts] = await db
    .select({
      signatures: sql<number>`(select count(*)::int from ${skillSignatures})`,
      links: sql<number>`(select count(*)::int from ${skillDuplicates})`,
      variants: sql<number>`(select count(*)::int from ${skills} where ${skills.canonicalSkillId} is not null)`,
      canonical: sql<number>`(select count(*)::int from ${skills} where ${skills.canonicalSkillId} is null)`,
    })
    .from(skills)
    .limit(1);

  const largest = await db
    .select({
      canonicalId: skillDuplicates.canonicalSkillId,
      name: skills.name,
      variants: sql<number>`count(*)::int`,
      minSimilarity: sql<number>`min(${skillDuplicates.similarity})`,
    })
    .from(skillDuplicates)
    .innerJoin(skills, eq(skills.id, skillDuplicates.canonicalSkillId))
    .groupBy(skillDuplicates.canonicalSkillId, skills.name)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  return { counts: counts ?? { signatures: 0, links: 0, variants: 0, canonical: 0 }, largest };
}

/** Versions still needing a signature at the current algorithm version. */
export async function pendingSignatureCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillVersions)
    .leftJoin(
      skillSignatures,
      and(
        eq(skillSignatures.skillVersionId, skillVersions.id),
        eq(skillSignatures.algorithmVersion, ALGORITHM_VERSION),
      ),
    )
    .where(and(eq(skillVersions.status, "indexed"), isNull(skillSignatures.id)));
  return row?.count ?? 0;
}

export { BAND_COUNT };
