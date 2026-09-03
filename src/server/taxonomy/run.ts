import "server-only";

import { and, asc, desc, eq, exists, inArray, isNull, ne, notExists, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  events,
  skillCategories,
  skills,
  skillStructures,
  skillVersions,
} from "@/server/db/schema";
import { gateEvidence } from "@/server/analytics/archetype";
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
  /**
   * Restrict the sample to skills already labelled under an **older** vocabulary version.
   *
   * Not the same as `force`, which re-does skills labelled at the *current* version. This
   * narrows the population so every skill in the batch has a counterpart under the previous
   * vocabulary — which is what makes `versionComparison()` a paired measurement instead of
   * two different samples being compared and hoped about.
   *
   * The reason it exists: after bumping to 1.2.0, an ordinary sample drew 100 skills of
   * which only **28** had 1.1.0 labels, and those 28 averaged 1.00 domain labels against
   * 1.72 corpus-wide — a biased subset, not a control group. Batch-to-batch the held rate
   * moved 6.9% → 9.9%, which is 1.6 standard deviations on that sample size and therefore
   * cannot distinguish "worse" from "unchanged". Pairing removes the sample mix entirely.
   */
  onlyPriorVersion?: boolean;
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

  /**
   * Has an assignment under some *other* vocabulary version.
   *
   * Combined with `unlabelled` below this reads "labelled before, not yet re-labelled",
   * which is exactly the paired population.
   */
  const labelledUnderAnotherVersion = exists(
    db
      .select({ one: sql`1` })
      .from(skillCategories)
      .where(
        and(
          eq(skillCategories.skillId, skills.id),
          /**
           * The *comparison* version, not "any version that is not current".
           *
           * `versionComparison` pairs against exactly one prior version, so a population
           * defined as the union over 1.0.0, 1.1.0 and 1.2.0 does not fill it. With 1.1.0
           * holding 4,349 skills against 1.2.0's 266, the documented workflow — `--sample
           * 300 --relabel` then `--compare` — drew overwhelmingly 1.1.0 skills and then
           * reported "no skill carries labels under both versions". The operator pays for
           * 300 classifications and gets nothing back, on the one command whose stated job
           * is deciding whether to spend ~$130.
           *
           * Both sides now resolve the prior version the same way, through
           * `priorVersionExpr`.
           */
          eq(skillCategories.classifierVersion, priorVersionExpr()),
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
    options.onlyPriorVersion ? labelledUnderAnotherVersion : undefined,
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

    /**
     * Both axes, or nothing is written.
     *
     * A skill needs a function (what archetype mining reads) and a domain (what browse and
     * `skills.categories` read). Writing only one leaves it half-labelled — and because
     * `selectSkills` asks whether *any* row exists at the current version, a half-labelled
     * skill is never offered again. It is not queued, not held for review, and not
     * reported: it simply has no domain for ever.
     *
     * Eight skills reached that state at 1.3.0. The cause is the loosened schema — no
     * `.min(1)` on `domains`, deliberately, because strict array bounds threw away whole
     * classifications and four of five skills failed that way before it was relaxed. The
     * bound belongs here rather than in the schema for the same reason every other policy
     * check does: the caller enforces policy, the schema describes shape. Failing the skill
     * leaves it unlabelled, so the next sample picks it up and pays for it once more —
     * which is the correct outcome and costs one call.
     */
    const axesPresent = new Set(pairs.map((pair) => pair.axis));
    if (pairs.length === 0 || axesPresent.size < 2) {
      report.failed += 1;
      errors.add(
        pairs.length === 0
          ? "no valid category ids survived vocabulary validation"
          : `only the ${[...axesPresent][0]} axis was assigned — a skill needs both`,
      );
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
 * Semver as a sortable value. `classifier_version` is `text`, and text sorts it wrong.
 *
 * `'1.9.0' > '1.10.0'` lexicographically, so every `max()` and `order by` over this column
 * is a latent off-by-one-release. It already misfired: the stale-version banner picked
 * 1.2.0 (266 skills) over 1.1.0 (4,349) — right by accident there, wrong the moment a
 * two-digit minor lands.
 */
const versionOrder = (column: unknown) => sql`string_to_array(${column}, '.')::int[]`;

/**
 * The servable set, per skill: its **own newest** vocabulary version, plus anything a
 * curator confirmed.
 *
 * Not `= TAXONOMY_VERSION`, and the difference only shows during a bump. The version clause
 * exists for a real reason — without it a skill re-classified under 1.1.0 kept its 1.0.0
 * labels too and `code-simplification` ended up serving `edit-refactor`, `generate-code`
 * and `transform-data` at once. Pinning to the *global* current version fixes that and
 * introduces a worse failure: the instant `TAXONOMY_VERSION` moves, every skill not yet
 * re-classified has no servable label at all, so `pnpm taxonomy --resync` — free,
 * documented as routine, described in CLAUDE.md as the thing to run *after a version bump*
 * — would have emptied `skills.categories` for **4,349 of 5,120 labelled skills**, a 76%
 * loss of registry browse coverage, silently.
 *
 * Per-skill newest keeps both properties: one vocabulary per skill, and a bump that
 * degrades nothing until the re-classification it triggers actually happens.
 */
/**
 * The single version `--compare` pairs against, resolved identically wherever it is needed.
 *
 * Newest superseded version by semver, as a scalar subquery so the selection population and
 * the comparison can never disagree about which one it is.
 */
function priorVersionExpr() {
  return sql`(
    select classifier_version from skill_categories
    where classifier_version <> ${TAXONOMY_VERSION}
    order by string_to_array(classifier_version, '.')::int[] desc
    limit 1
  )`;
}

const servableCategories = sql`
  with ranked as (
    select skill_id, value, confidence, reviewed_at,
           ${sql.raw("string_to_array(classifier_version, '.')::int[]")} as version_key,
           max(${sql.raw("string_to_array(classifier_version, '.')::int[]")})
             over (partition by skill_id) as newest_key
    from skill_categories
  )
  select skill_id, array_agg(distinct value order by value) as values
  from ranked
  where (version_key = newest_key or reviewed_at is not null)
    and (confidence >= ${REVIEW_FLOOR} or reviewed_at is not null)
  group by skill_id
`;

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
      select values from (${servableCategories}) sc where sc.skill_id = ${skillId}
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
 * Coverage per axis, plus how many categories can actually be mined.
 *
 * ## This number used to be measured in skills, and the miner does not agree
 *
 * It counted function categories with ≥50 *confident skills* and called them
 * "archetype-ready". The miner's gate is ≥50 distinct **structures** and ≥10 sources. Those
 * are not the same question, and the whole reason `categoryEvidence()` exists is that they
 * come apart: one generator's 300 clones are 300 skills and one structure.
 *
 * They came apart in public on 2026-09-03. `automate-browser` crossed 50 confident skills,
 * this line announced 13 categories ready, and the miner refused it at **46 structures**.
 * The status command was the more optimistic of the two and the less correct — the worst
 * combination, because it is the one someone reads to decide whether to mine.
 *
 * So readiness is now computed from `categoryEvidence()`, the same function whose floor the
 * miner applies. One definition, so the two cannot drift apart again.
 *
 * `MIN_BAND` is deliberately **not** applied here. It needs the curated/other split, which
 * is a property of `mineArchetype` rather than of the corpus, and a status command that
 * silently ran a full mine per category to print one line would be the wrong trade. A
 * category can therefore clear this and still fail at mine time on a thin band — which the
 * miner says plainly when it happens.
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

  /**
   * What the previous vocabulary decided, kept visible.
   *
   * `counts` above is filtered to `TAXONOMY_VERSION`, so the moment that constant is bumped
   * every coverage row disappears and the panel reads "Nothing classified yet" over a table
   * holding 12,944 assignments. That is technically true and operationally a lie: the labels
   * exist, they are still what the miner reads, and they are queued for re-classification
   * rather than gone.
   *
   * A blank screen is the one state an operator cannot tell apart from data loss, which is
   * the same argument the ingestion heartbeat makes — a completion record cannot answer "is
   * it stuck", and an empty table cannot answer "was this wiped".
   *
   * Newest prior version only, not every prior version summed: a skill labelled under both
   * 1.0.0 and 1.1.0 would be counted twice, and a number nobody can reconcile against the
   * table is worse than no number.
   */
  const [stalest] = await db
    .select({
      version: skillCategories.classifierVersion,
      assignments: sql<number>`count(*)::int`,
      skills: sql<number>`count(distinct ${skillCategories.skillId})::int`,
    })
    .from(skillCategories)
    .where(ne(skillCategories.classifierVersion, TAXONOMY_VERSION))
    .groupBy(skillCategories.classifierVersion)
    .orderBy(sql`${versionOrder(skillCategories.classifierVersion)} desc`)
    .limit(1);

  /**
   * Everything awaiting re-classification, across **all** superseded versions.
   *
   * `stalest` is the newest of them and labels the fallback cards; this is what the banner
   * counts, because "how much is pending" is not "how much is pending at one version". With
   * 1.0.0, 1.1.0 and 1.2.0 all live, quoting only the newest reported 278 assignments where
   * 11,614 were pending — a near-empty fallback presented as the whole picture, which is the
   * state this feature exists to prevent.
   */
  const [staleTotals] = await db
    .select({
      assignments: sql<number>`count(*)::int`,
      skills: sql<number>`count(distinct ${skillCategories.skillId})::int`,
    })
    .from(skillCategories)
    .where(ne(skillCategories.classifierVersion, TAXONOMY_VERSION));

  const priorCounts = stalest
    ? await db
        .select({
          axis: skillCategories.axis,
          value: skillCategories.value,
          total: sql<number>`count(*)::int`,
          confident: sql<number>`count(*) filter (where ${skillCategories.confidence} >= ${REVIEW_FLOOR})::int`,
          avgConfidence: sql<number>`coalesce(round(avg(${skillCategories.confidence}))::int, 0)`,
        })
        .from(skillCategories)
        .where(eq(skillCategories.classifierVersion, stalest.version))
        .groupBy(skillCategories.axis, skillCategories.value)
        .orderBy(desc(sql`count(*) filter (where ${skillCategories.confidence} >= ${REVIEW_FLOOR})`))
    : [];

  const evidence = await gateEvidence();
  const byCategory = new Map(evidence.map((e) => [e.category, e]));

  /** Trust the gate the evidence query computed — it applies MIN_BAND, which this cannot. */
  const meetsGate = (category: string) => byCategory.get(category)?.meetsGate ?? false;

  /**
   * Counted over `evidence`, not over `counts`, and the difference is a whole taxonomy
   * version.
   *
   * `counts` is filtered to `TAXONOMY_VERSION`; `mineArchetype` filters on no version at
   * all — it reads whatever servable assignment a skill currently carries. So immediately
   * after a bump, `counts` is empty while the miner can still mine every category from the
   * previous version's labels. Deriving readiness from `counts` reported **0 minable** at
   * the moment 1.2.0 landed, with twelve categories minable in fact.
   *
   * Which is the same bug this number was just fixed for: measuring the gate with something
   * that is not the gate.
   */
  const readyForArchetype = evidence.filter((e) => meetsGate(e.category)).length;

  return {
    counts,
    totals,
    /** Distinct structures and sources per function category — the miner's actual gate. */
    evidence,
    /**
     * The newest vocabulary version that is no longer current, and what it labelled.
     * Null when nothing is stale — the normal state between bumps.
     */
    stale: stalest
      ? {
          /** Newest superseded version — what the fallback cards are showing. */
          version: stalest.version,
          /** Across every superseded version, which is what "pending" means. */
          assignments: staleTotals?.assignments ?? 0,
          skills: staleTotals?.skills ?? 0,
        }
      : null,
    /** That version's per-category coverage, so a bumped panel is not blank. */
    priorCounts,
    currentVersion: TAXONOMY_VERSION,
    readyForArchetype,
    remaining: await remainingCount(),
    notClassifiable: await notClassifiableCount(),
  };
}

/**
 * Did changing the vocabulary help? **This cannot currently be answered, and the function
 * refuses rather than guessing.**
 *
 * ## Why a paired comparison is impossible here
 *
 * `skill_categories_uq` is `(skill_id, axis, value)`. `classifier_version` is a *column*,
 * not part of the key — so re-classifying a skill **updates its rows in place** and the
 * previous version's answer for that label is gone. `verdicts` is append-only per
 * `analyzer_version`; this table deliberately is not, because for *serving* a category only
 * the current answer matters.
 *
 * The consequence is that the rows still stamped with the old version, on a skill that has
 * been re-classified, are exactly the labels the new vocabulary **stopped assigning**.
 * Comparing those against the new version's full output compares what the new vocabulary
 * rejected with what it chose, and that comparison flatters the new vocabulary by
 * construction.
 *
 * It was not a subtle artifact. On the first attempt — 300 skills relabelled deliberately
 * to build a paired set — 146 skills carried both versions, holding **159 surviving old rows
 * against 390 new ones**, and **113 of the 146 had no surviving old function label at all**,
 * which is impossible for a skill that was ever classified. The apparent result was a domain
 * held rate falling 22.2% → 9.8%. That number is meaningless.
 *
 * ## What to do instead
 *
 * Either compare **unpaired at large n** — batch aggregates and, better, the *distribution*
 * of labels across categories, which is robust to sample mix in a way a held rate is not —
 * or give the table real history by adding `classifier_version` to the unique key. The
 * second makes this function possible and costs a migration plus a decision about which row
 * the read paths serve.
 *
 * Until then this returns `comparable: false` and says why. A command that prints a
 * confident wrong answer is worse than one that prints nothing: the whole reason this exists
 * is to decide whether to spend ~$130 on a bulk run.
 */
export async function versionComparison(): Promise<{
  currentVersion: string;
  priorVersion: string | null;
  pairedSkills: number;
  /** False when the prior version's rows have been partly overwritten. See the note above. */
  comparable: boolean;
  /** Why not, when `comparable` is false. */
  reason: string | null;
  axes: Array<{
    axis: CategoryAxis;
    priorAssignments: number;
    currentAssignments: number;
    priorAvgConfidence: number;
    currentAvgConfidence: number;
    priorHeld: number;
    currentHeld: number;
    priorHeldPct: number;
    currentHeldPct: number;
  }>;
  /** Categories whose share of the axis moved most, current minus prior. */
  moved: Array<{ axis: CategoryAxis; value: string; prior: number; current: number }>;
}> {
  const [prior] = await db
    .select({ version: skillCategories.classifierVersion })
    .from(skillCategories)
    .where(ne(skillCategories.classifierVersion, TAXONOMY_VERSION))
    .groupBy(skillCategories.classifierVersion)
    .orderBy(sql`${versionOrder(skillCategories.classifierVersion)} desc`)
    .limit(1);

  if (!prior) {
    return {
      currentVersion: TAXONOMY_VERSION,
      priorVersion: null,
      pairedSkills: 0,
      comparable: false,
      reason: `every assignment is at ${TAXONOMY_VERSION}; nothing to compare against`,
      axes: [],
      moved: [],
    };
  }

  const paired = sql`
    select skill_id from ${skillCategories} where classifier_version = ${TAXONOMY_VERSION}
    intersect
    select skill_id from ${skillCategories} where classifier_version = ${prior.version}
  `;

  /**
   * The integrity check that makes this honest.
   *
   * Every classified skill gets at least one function label, so a skill in the paired set
   * with no *prior* function label proves its prior rows were overwritten rather than kept.
   * One such skill is enough to invalidate the comparison, so the threshold is zero.
   */
  const [{ incomplete }] = (
    await db.execute(sql`
      with paired as (${paired})
      select count(*)::int as incomplete
      from paired p
      where not exists (
        select 1 from ${skillCategories} c
        where c.skill_id = p.skill_id
          and c.axis = 'function'
          and c.classifier_version = ${prior.version}
      )
    `)
  ).rows as Array<{ incomplete: number }>;

  const axes = await db.execute(sql`
    with paired as (${paired})
    select
      axis,
      count(*) filter (where classifier_version = ${prior.version})::int as prior_assignments,
      count(*) filter (where classifier_version = ${TAXONOMY_VERSION})::int as current_assignments,
      coalesce(round(avg(confidence) filter (where classifier_version = ${prior.version}))::int, 0) as prior_avg_confidence,
      coalesce(round(avg(confidence) filter (where classifier_version = ${TAXONOMY_VERSION}))::int, 0) as current_avg_confidence,
      count(*) filter (where classifier_version = ${prior.version} and confidence < ${REVIEW_FLOOR})::int as prior_held,
      count(*) filter (where classifier_version = ${TAXONOMY_VERSION} and confidence < ${REVIEW_FLOOR})::int as current_held
    from ${skillCategories}
    where skill_id in (select skill_id from paired)
      and classifier_version in (${prior.version}, ${TAXONOMY_VERSION})
    group by axis
    order by axis
  `);

  const moved = await db.execute(sql`
    with paired as (${paired})
    select axis, value,
      count(*) filter (where classifier_version = ${prior.version})::int as prior,
      count(*) filter (where classifier_version = ${TAXONOMY_VERSION})::int as current
    from ${skillCategories}
    where skill_id in (select skill_id from paired)
      and classifier_version in (${prior.version}, ${TAXONOMY_VERSION})
    group by axis, value
    having count(*) filter (where classifier_version = ${prior.version})
        <> count(*) filter (where classifier_version = ${TAXONOMY_VERSION})
    order by abs(
      count(*) filter (where classifier_version = ${TAXONOMY_VERSION})
      - count(*) filter (where classifier_version = ${prior.version})
    ) desc
    limit 15
  `);

  const [{ n }] = (
    await db.execute(sql`with paired as (${paired}) select count(*)::int as n from paired`)
  ).rows as Array<{ n: number }>;

  const pct = (held: number, total: number) =>
    total === 0 ? 0 : Math.round((held / total) * 1000) / 10;

  return {
    currentVersion: TAXONOMY_VERSION,
    priorVersion: prior.version,
    pairedSkills: n,
    comparable: incomplete === 0,
    reason:
      incomplete === 0
        ? null
        : `${incomplete} of ${n} paired skill(s) have no ${prior.version} function label, ` +
          `so their prior rows were overwritten in place — skill_categories_uq is ` +
          `(skill_id, axis, value) and does not include classifier_version. What survives ` +
          `at ${prior.version} is only what ${TAXONOMY_VERSION} stopped assigning, which ` +
          `is not a before-and-after.`,
    axes: (axes.rows as Array<Record<string, number | string>>).map((r) => ({
      axis: r.axis as CategoryAxis,
      priorAssignments: r.prior_assignments as number,
      currentAssignments: r.current_assignments as number,
      priorAvgConfidence: r.prior_avg_confidence as number,
      currentAvgConfidence: r.current_avg_confidence as number,
      priorHeld: r.prior_held as number,
      currentHeld: r.current_held as number,
      priorHeldPct: pct(r.prior_held as number, r.prior_assignments as number),
      currentHeldPct: pct(r.current_held as number, r.current_assignments as number),
    })),
    moved: (moved.rows as Array<Record<string, number | string>>).map((r) => ({
      axis: r.axis as CategoryAxis,
      value: r.value as string,
      prior: r.prior as number,
      current: r.current as number,
    })),
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
    with servable as (${servableCategories})
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
