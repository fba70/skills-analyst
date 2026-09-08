import "server-only";

import { and, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { skillCategories, skillEmbeddings, skills } from "@/server/db/schema";
import {
  isValidCategory,
  labelFor,
  REVIEW_FLOOR,
  type CategoryAxis,
} from "@/server/taxonomy/vocabulary";

import {
  composeInput,
  embedBatch,
  EMBEDDER_VERSION,
  EMBEDDING_MODEL,
  inputHash,
  type EmbedScope,
} from "./embeddings";

/**
 * The embedding backfill, and the similarity query it exists to serve.
 *
 * ## Bounded, resumable, and idempotent — because it costs money
 *
 * The same slice shape as every other pass here, with one difference that matters: the
 * extractor is free, so re-running it wastes seconds. This one bills. So the selector is
 * "canonical, indexed, and has no row at the current embedder version", and the write is
 * keyed on `(skill_version_id, embedder_version)` — meaning an interrupted run resumes
 * exactly where it stopped and a re-run of a finished corpus embeds nothing and charges
 * nothing.
 *
 * `input_hash` is the second guard. A version whose composed input is byte-identical to what
 * is already stored is skipped even when `--force` is passed, because paying twice for the
 * same string is never what force meant.
 *
 * ## Canonical only
 *
 * Near-duplicate variants are excluded. They are, by definition, the rows whose vectors
 * would be nearest to something already embedded, so including them would fill every
 * similarity result with clones of one skill and multiply the bill by the size of the
 * duplicate clusters. `canonical_skill_id is null` is the same filter archetype mining uses.
 */

export type EmbedOptions = {
  limit?: number;
  /** Re-embed rows that already exist at this version. Still skips unchanged input. */
  force?: boolean;
  /** How many values per provider call. */
  batchSize?: number;
  onProgress?: (message: string) => void;
};

export type EmbedReport = {
  embedded: number;
  /** Rows whose composed input was unchanged, so nothing was charged for them. */
  skippedUnchanged: number;
  failed: number;
  inputTokens: number;
  remaining: number;
};

/**
 * Values per provider call.
 *
 * 96 is a compromise with a specific failure in mind. Larger batches amortise the round trip
 * and this composition is tiny — a hundred summaries is a few thousand tokens — but a batch
 * is also the unit of loss: one rejected call discards every value in it, and the budget
 * check happens per batch, so an enormous batch can carry the platform total further past
 * the cap than a small one.
 */
const DEFAULT_BATCH = 96;

type Candidate = {
  skillId: string;
  skillVersionId: string;
  orgId: string | null;
  name: string;
  summary: string | null;
  categories: string[];
};

/**
 * Human labels, not raw slugs, and only servable assignments.
 *
 * `labelFor` turns `generate-document` into "Generate a document", which is what the model
 * should see — a slug embeds as a token salad. The confidence floor is the same one the
 * registry and the archetype miner apply, so a vector is never shaped by a label the
 * classifier itself flagged as unreliable.
 */
async function labelsFor(skillIds: readonly string[]): Promise<Map<string, string[]>> {
  if (skillIds.length === 0) return new Map();

  // `inArray`, not an interpolated `ARRAY[...]`. The ids come from our own rows so nothing
  // hostile can reach it today, but building SQL by string concatenation is a habit that
  // only has to be wrong once, and it breaks on an empty list into the bargain.
  const rows = await db
    .select({
      skillId: skillCategories.skillId,
      axis: skillCategories.axis,
      value: skillCategories.value,
    })
    .from(skillCategories)
    .where(
      and(
        inArray(skillCategories.skillId, [...skillIds]),
        or(
          gte(skillCategories.confidence, REVIEW_FLOOR),
          isNotNull(skillCategories.reviewedAt),
        ),
      ),
    );

  const byId = new Map<string, string[]>();
  for (const row of rows) {
    const list = byId.get(row.skillId) ?? [];
    list.push(labelFor(row.axis as CategoryAxis, row.value));
    byId.set(row.skillId, list);
  }
  return byId;
}

export async function embedCorpus(options: EmbedOptions = {}): Promise<EmbedReport> {
  const log = options.onProgress ?? (() => {});
  const limit = options.limit ?? 500;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH, 256));

  const missing = sql`not exists (
    select 1 from ${skillEmbeddings} e
    where e.skill_version_id = ${skills.currentVersionId}
      and e.embedder_version = ${EMBEDDER_VERSION}
  )`;

  const rows = (await db
    .select({
      skillId: skills.id,
      skillVersionId: skills.currentVersionId,
      orgId: skills.orgId,
      name: skills.name,
      summary: skills.summary,
      categories: skills.categories,
    })
    .from(skills)
    .where(
      options.force
        ? and(eq(skills.status, "indexed"), sql`${skills.canonicalSkillId} is null`, sql`${skills.currentVersionId} is not null`)
        : and(
            eq(skills.status, "indexed"),
            sql`${skills.canonicalSkillId} is null`,
            sql`${skills.currentVersionId} is not null`,
            missing,
          ),
    )
    .limit(limit)) as Candidate[];

  const report: EmbedReport = {
    embedded: 0,
    skippedUnchanged: 0,
    failed: 0,
    inputTokens: 0,
    remaining: 0,
  };

  const labels = await labelsFor(rows.map((r) => r.skillId));

  /** What is already stored, so an unchanged input is never paid for. */
  const existing = new Map<string, string>();
  if (rows.length > 0) {
    const stored = await db
      .select({
        skillVersionId: skillEmbeddings.skillVersionId,
        inputHash: skillEmbeddings.inputHash,
      })
      .from(skillEmbeddings)
      .where(
        and(
          eq(skillEmbeddings.embedderVersion, EMBEDDER_VERSION),
          inArray(
            skillEmbeddings.skillVersionId,
            rows.map((r) => r.skillVersionId),
          ),
        ),
      );
    for (const row of stored) existing.set(row.skillVersionId, row.inputHash);
  }

  const pending = rows
    .map((row) => {
      const composed = composeInput({
        name: row.name,
        summary: row.summary,
        labels: labels.get(row.skillId) ?? [],
      });
      return { row, composed, hash: inputHash(composed) };
    })
    .filter((item) => {
      if (existing.get(item.row.skillVersionId) === item.hash) {
        report.skippedUnchanged += 1;
        return false;
      }
      return true;
    });

  /**
   * Sequential batches, not concurrent ones.
   *
   * The opposite call from the bundle reads, and for a different bottleneck: those were
   * latency-bound against object storage, where six lanes turned 801 ms per bundle into 182.
   * This is a metered provider call behind a shared platform budget, and running batches in
   * parallel means several of them pass `assertWithinBudget` before any of their costs are
   * recorded — so the overshoot past the cap stops being bounded by one call, which is the
   * property RC.2's before-check/after-ledger order depends on.
   */
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      const result = await embedBatch(batch.map((item) => item.composed));
      report.inputTokens += result.inputTokens;

      await db.transaction(async (tx) => {
        for (const [index, item] of batch.entries()) {
          if (item.row.orgId) {
            await tx.execute(sql`select set_config('app.org_id', ${item.row.orgId}, true)`);
          }
          await tx
            .insert(skillEmbeddings)
            .values({
              orgId: item.row.orgId,
              skillId: item.row.skillId,
              skillVersionId: item.row.skillVersionId,
              embedderVersion: EMBEDDER_VERSION,
              model: result.model,
              inputHash: item.hash,
              // Per-row share of the batch's tokens. Approximate by construction — the
              // provider bills the batch — and recorded so a row's cost is traceable at all.
              inputTokens: Math.round(result.inputTokens / batch.length),
              embedding: result.vectors[index],
            })
            .onConflictDoUpdate({
              target: [skillEmbeddings.skillVersionId, skillEmbeddings.embedderVersion],
              set: {
                model: result.model,
                inputHash: item.hash,
                embedding: result.vectors[index],
                createdAt: new Date(),
              },
            });
        }
      });

      report.embedded += batch.length;
      log(`embedded ${report.embedded}`);
    } catch (error) {
      /**
       * Counted, not thrown — with one exception.
       *
       * A budget refusal is not a per-batch failure, it is the end of the run: continuing
       * would mean every remaining batch throwing the same error and the report claiming
       * hundreds of failures when the truth is one refusal. Everything else (a rejected
       * value, a transient gateway error) costs its own batch and no more.
       */
      if ((error as Error).name === "BudgetExceededError") throw error;
      report.failed += batch.length;
    }
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skills)
    .where(
      and(
        eq(skills.status, "indexed"),
        sql`${skills.canonicalSkillId} is null`,
        sql`${skills.currentVersionId} is not null`,
        missing,
      ),
    );
  report.remaining = count;

  return report;
}

/** Coverage, for the CLI and the settings panel. */
export async function embeddingSummary() {
  const [totals] = await db
    .select({
      embedded: sql<number>`count(*) filter (where ${skillEmbeddings.embedderVersion} = ${EMBEDDER_VERSION})::int`,
      allVersions: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${skillEmbeddings.inputTokens}), 0)::int`,
    })
    .from(skillEmbeddings);

  const [{ eligible }] = await db
    .select({ eligible: sql<number>`count(*)::int` })
    .from(skills)
    .where(
      and(
        eq(skills.status, "indexed"),
        sql`${skills.canonicalSkillId} is null`,
        sql`${skills.currentVersionId} is not null`,
      ),
    );

  return { totals, eligible, model: EMBEDDING_MODEL, version: EMBEDDER_VERSION };
}

/**
 * A bare category value to a human label, trying both axes.
 *
 * `labelFor` returns its input unchanged when the value is not in the axis it was given, so
 * "did it resolve" has to be asked with `isValidCategory` rather than inferred from the
 * answer looking different.
 */
function resolveCategoryLabel(value: string): string {
  const axes: CategoryAxis[] = ["function", "domain"];
  for (const axis of axes) {
    if (isValidCategory(axis, value)) return labelFor(axis, value);
  }
  return value;
}

export type SimilarSkill = {
  slug: string;
  name: string;
  summary: string | null;
  /** Cosine similarity, 0–1. Higher is closer. */
  similarity: number;
  /** So an author can see whether the near neighbour is any good. */
  qualityScore: number | null;
  /** Human category labels, which is most of "how yours differs" (R3.6). */
  categories: string[];
};

export type SimilarityReport = {
  hits: SimilarSkill[];
  /**
   * Embedded skills over eligible skills, as a percentage.
   *
   * Returned with every answer, because a similarity result is only as complete as the index
   * behind it. During a backfill "no similar skills" and "nothing comparable has been
   * embedded yet" look identical to an author, and only one of them means what it says —
   * which is the same trap `archetypes --blocks` printed eleven rows of zeros into.
   */
  coveragePercent: number;
  /** True once the index is complete enough that an empty result is informative. */
  reliable: boolean;
};

/**
 * Coverage below which an empty or thin result says more about the index than the corpus.
 *
 * 90% rather than 100: the last few per cent are skills arriving faster than the backfill,
 * and waiting for a number that never quite settles would mean the feature is never on.
 */
export const RELIABLE_COVERAGE = 90;

/**
 * Shortest query worth embedding.
 *
 * Below this the vector is noise, and noise has *nearest neighbours* — the query returns six
 * arbitrary skills with confident-looking cosine scores, which is worse than returning
 * nothing because an author cannot tell the difference. It is also paid for.
 *
 * The guard lives here rather than only in the caller. It was in the builder action first,
 * and `verify:embeddings` then showed `similarToText("x")` happily returning ten neighbours
 * and billing for them — a guard one call site remembers is a guard the CLI does not have.
 */
export const MIN_QUERY_CHARS = 20;

/**
 * The nearest skills to a piece of text (R3.6, and RW.8's collision check).
 *
 * Written now rather than with its first caller, so the vectors are not a table nobody
 * reads: an index that has never answered a query is an index nobody knows is wrong.
 *
 * Public corpus only, and `indexed` only — the same live filter archetype exemplars use, so
 * a skill quarantined since the backfill stops being offered as a neighbour rather than
 * going on being suggested from a stored list.
 */
export async function similarToText(
  text: string,
  options: {
    limit?: number;
    excludeSkillId?: string;
    /**
     * Whose budget pays (plan step D2).
     *
     * Omitted, it is the platform's — right for the CLI and for corpus work. An
     * author-initiated check must pass their organisation, or every similarity press bills the
     * corpus-analysis budget and a busy month of authoring halts the backfill. That is the
     * mixing RC.2 keeps two budgets to prevent, and this call site had it backwards since B3.
     */
    scope?: EmbedScope;
  } = {},
): Promise<SimilarityReport> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));

  const { totals, eligible } = await embeddingSummary();
  const coveragePercent = eligible > 0 ? Math.round((totals.embedded / eligible) * 100) : 0;
  const report = { coveragePercent, reliable: coveragePercent >= RELIABLE_COVERAGE };

  // Too short to mean anything, and refused before anything is charged for.
  if (text.trim().length < MIN_QUERY_CHARS) return { ...report, hits: [] };

  /**
   * Nothing embedded means no answer, and **no charge**.
   *
   * Checked before `embedBatch` rather than after: embedding the author's text to compare it
   * against an empty index would bill for a question that cannot be answered.
   */
  if (totals.embedded === 0) return { ...report, hits: [] };

  const { vectors } = await embedBatch([text], options.scope);
  if (vectors.length === 0) return { ...report, hits: [] };

  return { ...report, hits: await nearestToVector(vectors[0], limit, options.excludeSkillId) };
}

/**
 * The nearest skills to a vector somebody else already paid for (plan step D2).
 *
 * RW.8's collision check needs the *same* probe vector twice: once to find the corpus
 * neighbours, and once to measure how close the probe sits to the draft's own description.
 * Going through `similarToText` would embed each probe a second time — a real charge for a
 * vector already in memory, and worse, two vectors of the same text that could differ if the
 * embedding model ever moved between the calls.
 *
 * So the query half lives here and `similarToText` is the text-taking wrapper around it. One
 * definition of "what counts as a neighbour": public corpus, `indexed`, canonical only, at the
 * current embedder version. A second copy of that `where` clause is how the collision lab and
 * the author-facing similarity panel would come to disagree about which skills exist.
 */
export async function nearestToVector(
  vector: number[],
  limit: number,
  excludeSkillId?: string,
): Promise<SimilarSkill[]> {
  const literal = `[${vector.join(",")}]`;

  const result = await db.execute(sql`
    select s.slug, s.name, s.summary, s.quality_score, s.categories,
           1 - (e.embedding <=> ${literal}::vector) as similarity
    from ${skillEmbeddings} e
    join ${skills} s on s.id = e.skill_id
    where e.embedder_version = ${EMBEDDER_VERSION}
      and e.org_id is null
      and s.status = 'indexed'
      and s.canonical_skill_id is null
      ${excludeSkillId ? sql`and s.id <> ${excludeSkillId}` : sql``}
    order by e.embedding <=> ${literal}::vector
    limit ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    slug: row.slug as string,
    name: row.name as string,
    summary: (row.summary as string | null) ?? null,
    similarity: Math.round(Number(row.similarity) * 1000) / 1000,
    qualityScore: (row.quality_score as number | null) ?? null,
    /**
     * `skills.categories` is the denormalised read path and holds only servable labels at the
     * current taxonomy version — the same list the registry filters on. Resolved to human
     * words, because `generate-document` in a UI is a slug leaking into a sentence.
     *
     * The entries are **bare values with no axis prefix**, so the axis has to be discovered
     * rather than assumed. Defaulting to `function` looked right and shipped wrong: a first
     * run rendered "Review & critique · software-engineering", the function label resolved
     * and every domain one falling through `labelFor`'s pass-through as a raw slug. Both
     * axes are tried, and an unrecognised value keeps its slug rather than disappearing —
     * a missing category is harder to notice than an ugly one.
     */
    categories: (((row.categories ?? []) as string[]) ?? []).map((entry) =>
      resolveCategoryLabel(entry),
    ),
  }));

}
