import "server-only";

import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  events,
  skillCategories,
  skills,
  skillStructures,
  skillVersions,
} from "@/server/db/schema";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import {
  isClassifiable,
  isNotClassifiable,
  NOT_CLASSIFIABLE_REASON,
} from "./classifiable";
import { pageWindow, type Paged, type PageQuery } from "@/server/dal/paging";

import {
  classifyBatch,
  DEFAULT_BATCH,
  MAX_BATCH,
  needsReview,
  type BatchItem,
} from "./classify";
import {
  isValidCategory,
  REVIEW_FLOOR,
  TAXONOMY_VERSION,
  type CategoryAxis,
} from "./vocabulary";

/**
 * Running the classifier over a slice of the corpus and storing what it decided.
 *
 * **Sampling is the default, not full-corpus.** `classifySample` is the entry point, it
 * takes an explicit size, and the classifier itself refuses anything over `MAX_BATCH`.
 * Getting a taxonomy right is an iterative business — read the labels, disagree with some,
 * change a category description, run again — and doing that against the whole corpus means
 * paying for every wrong version of the vocabulary. So the loop is: small sample, read the
 * output, adjust, repeat. Only once the labels look right does a wider run make sense, and
 * that is a decision to take deliberately with the cost in view.
 *
 * `--strategy diverse` exists for the same reason: twenty skills off the top of an
 * unordered scan tell you much less than twenty spread across sources and quality bands.
 */

export type SampleStrategy = "diverse" | "recent" | "top-quality";

export type ClassifyRunOptions = {
  limit?: number;
  strategy?: SampleStrategy;
  /** Re-classify skills that already carry labels at this taxonomy version. */
  force?: boolean;
  /** Only these skill ids — used by the curator UI to re-run one. */
  skillIds?: string[];
  onProgress?: (message: string) => void;
};

export type ClassifyRunReport = {
  requested: number;
  classified: number;
  failed: number;
  assignments: number;
  held: number;
  invalidIds: string[];
  /**
   * Why the failures failed, deduplicated.
   *
   * Counting failures without keeping their reasons makes a classification run
   * undebuggable — "3 failed" is indistinguishable between a rate limit, a schema
   * mismatch and a model refusal, and those need three different fixes.
   */
  errors: string[];
  remaining: number;
};

/**
 * Picks which skills to label.
 *
 * `diverse` spreads the sample across sources and quality rather than taking whatever the
 * scan returns first: a sample drawn from one repository would tell us the vocabulary fits
 * that repository. It orders by a hash so the spread is stable across runs — re-running
 * the same sample after a prompt change is how you tell a prompt improvement from noise.
 */
async function selectSkills(options: ClassifyRunOptions) {
  const limit = Math.min(options.limit ?? DEFAULT_BATCH, MAX_BATCH);

  const unlabelled = notExists(
    db
      .select({ one: sql`1` })
      .from(skillCategories)
      .where(
        and(
          eq(skillCategories.skillId, skills.id),
          eq(skillCategories.classifierVersion, TAXONOMY_VERSION),
        ),
      ),
  );

  const base = and(
    eq(skills.status, "indexed"),
    // A variant is labelled through its canonical entry; labelling both pays twice for
    // one answer and lets the two disagree.
    isNull(skills.canonicalSkillId),
    // Nothing to read, nothing to classify. Skipped before the model is called, so this
    // saves the call as well as the low-confidence row it would have produced.
    isClassifiable(),
    options.force ? undefined : unlabelled,
  );

  const where = options.skillIds?.length ? inArray(skills.id, options.skillIds) : base;

  const order = (() => {
    switch (options.strategy) {
      case "recent":
        return [desc(skillVersions.syncedAt)];
      case "top-quality":
        return [desc(skills.qualityScore)];
      default:
        /**
         * Round-robin across sources, then stable pseudo-random inside each.
         *
         * A plain random sample is not a diverse one when the corpus is lopsided, and this
         * corpus is *extremely* lopsided: `mohitagw15856/pm-claude-skills` alone supplies
         * 2,067 of 2,329 fingerprinted skills — 89% — and 1,985 of those are clones of a
         * single generated template. A 20-skill random sample would draw ~18 from that one
         * repository, and every conclusion about the vocabulary would really be a
         * conclusion about that repository's template.
         *
         * Ranking within source and ordering by rank first takes one skill from each
         * source before taking a second from any, so a sample of 20 sees up to 20 distinct
         * sources. The md5 tiebreak keeps it reproducible across runs, which is what makes
         * "did that prompt change help?" answerable.
         */
        return [
          sql`row_number() over (partition by ${skillVersions.sourceId} order by md5(${skills.id}::text))`,
          sql`md5(${skills.id}::text)`,
          asc(skills.id),
        ];
    }
  })();

  return db
    .select({
      id: skills.id,
      orgId: skills.orgId,
      name: skills.name,
      slug: skills.slug,
      summary: skills.summary,
      sectionRoles: skillStructures.sectionRoles,
      resourceDirs: skillStructures.resourceDirs,
      codeLanguages: skillStructures.codeLanguages,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
    // Left join: a missing fingerprint costs the classifier some evidence but must not
    // hide the skill, or taxonomy coverage would silently inherit extraction coverage.
    .leftJoin(
      skillStructures,
      and(
        eq(skillStructures.skillVersionId, skillVersions.id),
        eq(skillStructures.extractorVersion, EXTRACTOR_VERSION),
      ),
    )
    .where(where)
    .orderBy(...order)
    .limit(limit);
}

export async function classifySample(
  options: ClassifyRunOptions = {},
): Promise<ClassifyRunReport> {
  const log = options.onProgress ?? (() => {});
  const rows = await selectSkills(options);

  const report: ClassifyRunReport = {
    requested: rows.length,
    classified: 0,
    failed: 0,
    assignments: 0,
    held: 0,
    invalidIds: [],
    errors: [],
    remaining: 0,
  };

  if (rows.length === 0) return { ...report, remaining: await remainingCount() };

  const items: BatchItem[] = rows.map((row) => ({
    skillId: row.id,
    name: row.name,
    description: row.summary,
    sectionRoles: row.sectionRoles ?? undefined,
    resourceDirs: row.resourceDirs ?? undefined,
    codeLanguages: row.codeLanguages ?? undefined,
  }));

  const outcomes = await classifyBatch(items, { onProgress: log });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const invalid = new Set<string>();
  const errors = new Set<string>();

  for (const outcome of outcomes) {
    if (!outcome.result) {
      report.failed += 1;
      if (outcome.error) errors.add(outcome.error);
      continue;
    }
    const row = byId.get(outcome.skillId);
    if (!row) continue;

    const { classification, model, classifierVersion } = outcome.result;

    const pairs = [
      ...classification.functions.map((a) => ({ axis: "function" as const, ...a })),
      ...classification.domains.map((a) => ({ axis: "domain" as const, ...a })),
    ].filter((a) => {
      // The schema guarantees a string, not membership. An id outside the vocabulary is
      // dropped and counted — a silent coercion to some nearby category would be a
      // taxonomy that quietly means something other than what it says.
      const ok = isValidCategory(a.axis, a.id);
      if (!ok) invalid.add(`${a.axis}:${a.id}`);
      return ok;
    });

    if (pairs.length === 0) {
      report.failed += 1;
      errors.add("no valid category ids survived vocabulary validation");
      continue;
    }

    await db.transaction(async (tx) => {
      if (row.orgId) {
        await tx.execute(sql`select set_config('app.org_id', ${row.orgId}, true)`);
      }

      for (const pair of pairs) {
        const confidence = Math.round(pair.confidence);
        await tx
          .insert(skillCategories)
          .values({
            orgId: row.orgId,
            skillId: row.id,
            axis: pair.axis,
            value: pair.id,
            confidence,
            assignedBy: "classifier",
            classifierVersion,
            model,
            rationale: classification.rationale || null,
          })
          .onConflictDoUpdate({
            target: [skillCategories.skillId, skillCategories.axis, skillCategories.value],
            set: {
              confidence,
              classifierVersion,
              model,
              rationale: classification.rationale || null,
              createdAt: new Date(),
            },
            // A curator's answer is final. Re-running the classifier must never quietly
            // overwrite a human decision — that is the whole point of the review queue.
            setWhere: isNull(skillCategories.reviewedAt),
          });

        report.assignments += 1;
        if (needsReview(confidence)) report.held += 1;
      }

      // Denormalise the confident labels onto `skills.categories`, which is what the
      // registry list and its GIN index already read. Held assignments stay out of it:
      // a category nobody has confirmed should not steer browse.
      await syncCategoriesArray(tx, row.id);
    });

    report.classified += 1;
  }

  report.invalidIds = [...invalid].sort();
  report.errors = [...errors];
  report.remaining = await remainingCount();
  await db.insert(events).values({
    actorType: "system",
    actorId: "taxonomy.classify",
    kind: "taxonomy.classified",
    subjectType: "skill_categories",
    reason: `taxonomy ${TAXONOMY_VERSION}`,
    payload: {
      requested: report.requested,
      classified: report.classified,
      failed: report.failed,
      assignments: report.assignments,
      held: report.held,
      invalidIds: report.invalidIds,
      errors: report.errors,
    },
  });

  return report;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mirrors confident assignments into the denormalised `skills.categories` array.
 *
 * Scoped to the **current** taxonomy version, plus anything a curator confirmed.
 * Without the version clause, assignments from a superseded vocabulary keep steering
 * browse forever: re-classifying `code-simplification` under taxonomy 1.1.0 correctly gave
 * it `edit-refactor`, but its 1.0.0 rows still said `generate-code` and `transform-data`,
 * and the array ended up with all three. The old rows are kept — they are the record of
 * what the previous vocabulary decided — they simply stop being served.
 *
 * A curator-reviewed row survives a version change on purpose. A human confirmed that
 * category for that skill; a vocabulary edit elsewhere does not un-confirm it.
 */
async function syncCategoriesArray(tx: Tx, skillId: string): Promise<void> {
  await tx.execute(sql`
    update ${skills}
    set categories = coalesce((
      select array_agg(distinct value order by value)
      from ${skillCategories}
      where skill_id = ${skillId}
        and (classifier_version = ${TAXONOMY_VERSION} or reviewed_at is not null)
        and (confidence >= ${REVIEW_FLOOR} or reviewed_at is not null)
    ), '{}'::text[])
    where id = ${skillId}
  `);
}

/**
 * Skills still to classify — excluding the ones that never can be.
 *
 * Without the rule this number could not reach zero: a skill with no description is
 * unlabelled for ever, so "remaining" would settle at a floor and the taxonomy would look
 * permanently unfinished. Those are counted separately by `notClassifiableCount`, which is
 * the honest split — one number is work, the other is a corpus-quality fact.
 */
/** Indexed, canonical, and with nothing a classifier could read. Never queued, never paid for. */
export async function notClassifiableCount(): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skills)
    .where(
      and(eq(skills.status, "indexed"), isNull(skills.canonicalSkillId), isNotClassifiable()),
    );
  return count;
}

async function remainingCount(): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skills)
    .where(
      and(
        eq(skills.status, "indexed"),
        isNull(skills.canonicalSkillId),
        isClassifiable(),
        notExists(
          db
            .select({ one: sql`1` })
            .from(skillCategories)
            .where(
              and(
                eq(skillCategories.skillId, skills.id),
                eq(skillCategories.classifierVersion, TAXONOMY_VERSION),
              ),
            ),
        ),
      ),
    );
  return count;
}

/**
 * Coverage per axis, plus how many categories have cleared the archetype threshold.
 *
 * The last number is the one that matters for planning: R3.2 needs ≥50 validated skills in
 * a category before an archetype built from it means anything, and until functions start
 * crossing it, archetype mining has nothing to mine.
 */
export const ARCHETYPE_THRESHOLD = 50;

export async function taxonomySummary() {
  const counts = await db
    .select({
      axis: skillCategories.axis,
      value: skillCategories.value,
      total: sql<number>`count(*)::int`,
      confident: sql<number>`count(*) filter (where ${skillCategories.confidence} >= ${REVIEW_FLOOR})::int`,
      avgConfidence: sql<number>`coalesce(round(avg(${skillCategories.confidence}))::int, 0)`,
    })
    .from(skillCategories)
    .where(eq(skillCategories.classifierVersion, TAXONOMY_VERSION))
    .groupBy(skillCategories.axis, skillCategories.value)
    .orderBy(desc(sql`count(*)`));

  const [totals] = await db
    .select({
      assignments: sql<number>`count(*)::int`,
      skillsLabelled: sql<number>`count(distinct ${skillCategories.skillId})::int`,
      held: sql<number>`count(*) filter (where ${skillCategories.confidence} < ${REVIEW_FLOOR} and ${skillCategories.reviewedAt} is null)::int`,
      reviewed: sql<number>`count(*) filter (where ${skillCategories.reviewedAt} is not null)::int`,
    })
    .from(skillCategories)
    .where(eq(skillCategories.classifierVersion, TAXONOMY_VERSION));

  const readyForArchetype = counts.filter(
    (c) => c.axis === "function" && c.confident >= ARCHETYPE_THRESHOLD,
  ).length;

  return {
    counts,
    totals,
    readyForArchetype,
    remaining: await remainingCount(),
    notClassifiable: await notClassifiableCount(),
  };
}

export type QueueItem = {
  id: string;
  skillId: string;
  slug: string;
  name: string;
  summary: string | null;
  // The enum type, not `string`: the panel maps this to a label per axis, and widening it
  // here would make that lookup silently accept anything.
  axis: CategoryAxis;
  value: string;
  confidence: number;
  rationale: string | null;
};

/**
 * The low-confidence queue (R3.1): worst first, so a curator's time goes where it pays.
 *
 * **Paged, and the count is the point.** This used to take a bare `limit` and return the
 * worst 25 with no total beside them, which made the panel actively misleading: deciding a
 * row deleted or pinned it, the page revalidated, and the next-worst row slid into the
 * empty slot. The list came back exactly as long as before. With 1,130 assignments held,
 * every correct decision looked like it had been undone.
 *
 * Returning `total` is what makes the work legible — "20 of 1,130" says both that the
 * decision landed and that the queue is far deeper than one screen. It also says something
 * the UI could not previously admit: at this depth the queue is not clearable by hand, and
 * that is a fact about `REVIEW_FLOOR`, not about the curator.
 */
export async function reviewQueue(query: PageQuery = {}): Promise<Paged<QueueItem>> {
  const where = and(
    eq(skillCategories.classifierVersion, TAXONOMY_VERSION),
    isNull(skillCategories.reviewedAt),
    sql`${skillCategories.confidence} < ${REVIEW_FLOOR}`,
    // A row a curator cannot decide is not a queue item. These are cleared by
    // `sweepNotClassifiable`; excluding them here means the queue never shows one even
    // between a sync and the next sweep.
    isClassifiable(),
  );

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(skillCategories)
    .innerJoin(skills, eq(skills.id, skillCategories.skillId))
    .where(where);

  const window = pageWindow(total, query.page, query.pageSize);

  const items = await db
    .select({
      id: skillCategories.id,
      skillId: skillCategories.skillId,
      slug: skills.slug,
      name: skills.name,
      summary: skills.summary,
      axis: skillCategories.axis,
      value: skillCategories.value,
      confidence: skillCategories.confidence,
      rationale: skillCategories.rationale,
    })
    .from(skillCategories)
    .innerJoin(skills, eq(skills.id, skillCategories.skillId))
    .where(where)
    /**
     * `id` breaks the tie, and it is not decoration.
     *
     * Confidence alone is not a total order — hundreds of rows share a score — so two
     * queries could return the same page in a different order, and a row could appear on
     * page 1 and page 2 or on neither. Deciding rows *removes* them from this set while a
     * curator is paging through it, which is exactly the workload that exposes an unstable
     * sort.
     */
    .orderBy(asc(skillCategories.confidence), asc(skillCategories.id))
    .limit(window.pageSize)
    .offset(window.offset);

  return { items, total, page: window.page, pageSize: window.pageSize, pageCount: window.pageCount };
}

/**
 * A curator's decision on one held assignment (R3.1).
 *
 * `confirm` promotes it to full confidence; `reject` deletes the row rather than storing a
 * zero. A rejected category is not "a category we are unsure about" — it is a category the
 * skill does not have, and leaving it behind at low confidence would keep it in the queue
 * forever and keep it visible to anything that reads assignments without filtering.
 *
 * Either way `reviewed_at` is what makes the decision stick: the classifier's upsert
 * carries `setWhere: reviewedAt is null`, so a later re-run cannot overwrite a human.
 */
export async function reviewCategory(
  categoryId: string,
  decision: "confirm" | "reject",
  reviewer: string,
): Promise<{ skillId: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ skillId: skillCategories.skillId, orgId: skillCategories.orgId })
      .from(skillCategories)
      .where(eq(skillCategories.id, categoryId))
      .limit(1);
    if (!row) throw new Error("That category assignment no longer exists.");

    if (row.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${row.orgId}, true)`);
    }

    if (decision === "reject") {
      await tx.delete(skillCategories).where(eq(skillCategories.id, categoryId));
    } else {
      await tx
        .update(skillCategories)
        .set({
          confidence: 100,
          assignedBy: "curator",
          reviewedAt: new Date(),
          reviewedBy: reviewer,
        })
        .where(eq(skillCategories.id, categoryId));
    }

    await syncCategoriesArray(tx, row.skillId);

    await tx.insert(events).values({
      actorType: "user",
      actorId: reviewer,
      kind: `taxonomy.${decision}ed`,
      subjectType: "skill_categories",
      subjectId: categoryId,
      reason: `curator ${decision}`,
      payload: { skillId: row.skillId },
    });

    return { skillId: row.skillId };
  });
}


/**
 * Recomputes `skills.categories` for every labelled skill.
 *
 * The per-skill sync only runs when that skill is classified or reviewed, so a change to
 * what counts as servable — a taxonomy version bump, a confidence-floor change — leaves
 * every previously-written array stale. This is the backfill for exactly that, and it is
 * pure SQL: one statement over the join, no model, no cost.
 */
export async function resyncCategoryArrays(): Promise<number> {
  const result = await db.execute(sql`
    with servable as (
      select skill_id, array_agg(distinct value order by value) as values
      from ${skillCategories}
      where (classifier_version = ${TAXONOMY_VERSION} or reviewed_at is not null)
        and (confidence >= ${REVIEW_FLOOR} or reviewed_at is not null)
      group by skill_id
    )
    update ${skills} s
    set categories = coalesce(servable.values, '{}'::text[])
    from servable
    where s.id = servable.skill_id
      and s.categories is distinct from coalesce(servable.values, '{}'::text[])
  `);
  return result.rowCount ?? 0;
}


export type SweepResult = {
  /** Assignments the rule matched. Equal to `deleted` unless this was a dry run. */
  matched: number;
  /** Assignments actually deleted — zero on a dry run. */
  deleted: number;
  /** Distinct skills those assignments belonged to. */
  skills: number;
  /** Held assignments left, which no rule can decide. */
  remainingHeld: number;
};

/**
 * Clears held assignments the classifier should never have been asked to make.
 *
 * Free, offline, re-runnable, and a sibling to `reapplyMarkerThreshold` — a rule added
 * after the fact is not finished until the rows decided before it are re-judged. The
 * selector now skips these skills, so nothing new accumulates; this is the backlog.
 *
 * **Deleted, not marked reviewed.** `reviewed_at` means a human decided, and the upsert's
 * `setWhere: reviewedAt is null` treats it as a pin — so marking these would freeze a guess
 * in place and stop a later, better-described version of the skill ever being classified.
 * Deleting matches what `reviewCategory("reject")` already does and for the same reason: a
 * category the skill does not have is not a category we are unsure about.
 *
 * Only *held* rows are touched. A confident assignment on a thin description is left alone
 * — two exist, and removing a label a curator can still see and reject is a bigger
 * intervention than this rule has earned.
 */
export async function sweepNotClassifiable(
  options: { dryRun?: boolean } = {},
): Promise<SweepResult> {
  const doomed = await db
    .select({ id: skillCategories.id, skillId: skillCategories.skillId })
    .from(skillCategories)
    .innerJoin(skills, eq(skills.id, skillCategories.skillId))
    .where(
      and(
        eq(skillCategories.classifierVersion, TAXONOMY_VERSION),
        isNull(skillCategories.reviewedAt),
        sql`${skillCategories.confidence} < ${REVIEW_FLOOR}`,
        isNotClassifiable(),
      ),
    );

  const skillIds = [...new Set(doomed.map((row) => row.skillId))];

  if (!options.dryRun && doomed.length > 0) {
    await db.transaction(async (tx) => {
      await tx.delete(skillCategories).where(
        inArray(
          skillCategories.id,
          doomed.map((row) => row.id),
        ),
      );

      await tx.insert(events).values({
        actorType: "system",
        actorId: "taxonomy.sweep",
        kind: "taxonomy.not_classifiable_cleared",
        subjectType: "skill_categories",
        reason: NOT_CLASSIFIABLE_REASON,
        payload: { assignments: doomed.length, skills: skillIds.length },
      });
    });
  }

  const [{ remainingHeld }] = await db
    .select({ remainingHeld: sql<number>`count(*)::int` })
    .from(skillCategories)
    .innerJoin(skills, eq(skills.id, skillCategories.skillId))
    .where(
      and(
        eq(skillCategories.classifierVersion, TAXONOMY_VERSION),
        isNull(skillCategories.reviewedAt),
        sql`${skillCategories.confidence} < ${REVIEW_FLOOR}`,
      ),
    );

  return {
    matched: doomed.length,
    deleted: options.dryRun ? 0 : doomed.length,
    skills: skillIds.length,
    remainingHeld,
  };
}
