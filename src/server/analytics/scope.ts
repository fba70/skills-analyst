import "server-only";

import { and, eq, sql } from "drizzle-orm";

import {
  analyseCohesion,
  analyseDisclosure,
  MIN_BLOCKS_TO_JUDGE,
  SCOPE_ANALYSER_VERSION,
  type DisclosureReport,
  type ScopeReport,
  type ScopeVerdict,
} from "@/lib/scope";
import { DISCLOSURE_HINT_BYTES } from "@/lib/tokens";
import { readMarkerBody } from "@/server/analytics/block-library";
import { embedBatch, EMBEDDING_MODEL, type EmbedScope } from "@/server/analytics/embeddings";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { db } from "@/server/db";
import { skillScope } from "@/server/db/schema";

/**
 * The scope analyser and the disclosure restructurer (Doc 6 RW.10 / RW.11, plan step C5).
 *
 * ## Pointed at the corpus first, deliberately
 *
 * The plan says to run this over published skills before it reaches anybody's draft, and the
 * reason is the one this codebase keeps paying for: **a metric is worth what its worst
 * confident answer costs.** Telling an author to cut their document in half is the most
 * expensive advice this platform can give, and the cheapest way to find out whether the
 * measurement earns that is to run it over 49,000 documents nobody will be upset about and read
 * the output. Same posture as `pnpm structures --probe`, which found three detector defects
 * before a single block row was written.
 *
 * So there is a CLI and a stored verdict, and **no builder panel yet**. That is a decision, not
 * an omission.
 *
 * ## A second embedder, over a different unit
 *
 * A6's vectors are one per skill over *name, summary and category labels* — the claim, not the
 * document. `embeddings.ts` says in as many words that body-level similarity would need "a
 * second embedder over blocks, a different unit with its own composition, not a wider window on
 * this one". This is that second embedder, and it is the first caller.
 *
 * It reuses `embedBatch` — the same model, the same pricing entry, the same budget check and the
 * same ledger row — and reuses none of the stored vectors, because comparing a passage against a
 * summary would be comparing two populations that only look alike.
 *
 * ## What it refuses to analyse, and why each refusal matters
 *
 * - **Unlicensed skills.** `metadata_only` and `unresolved` have no stored bytes, so their block
 *   text cannot be read at all. Skipped with the reason named, never scored as cohesive — an
 *   absent measurement and a good result must not render as the same row.
 * - **Short documents.** Below `MIN_BLOCKS_TO_JUDGE` the verdict is `not-measurable`.
 * - **Short blocks.** A four-word passage embeds to noise that sits near everything, which drags
 *   cohesion up and hides real seams.
 */

/**
 * The block embedder's own version.
 *
 * Model, width and **unit** — the last field is the whole reason this is a separate constant
 * from `EMBEDDER_VERSION`. Same model and same width as A6, and vectors that must never be
 * compared with A6's, because one is a skill's claim and the other is a passage inside it. A
 * shared version string would make two incomparable populations indistinguishable in a column.
 */
export const BLOCK_EMBEDDER_VERSION = "1.0.0:text-embedding-3-small:1536:block-text";

/**
 * Blocks shorter than this are not embedded.
 *
 * A very short passage embeds to something close to the average of its vocabulary, which sits
 * near everything else in the document — so including them inflates cohesion and, worse, blurs
 * the seam between two genuinely different halves. The floor is lower than the block library's
 * `FRAGMENT_MIN_WORDS` because this is a measurement rather than an exhibit: a 10-word decision
 * rule is poor reading and perfectly good evidence.
 */
export const SCOPE_MIN_BLOCK_WORDS = 8;

/** Corpus analysis, on the platform budget — the same pocket the A6 backfill spends from. */
const SCOPE_EMBED_SCOPE: EmbedScope = { purpose: "corpus_embedding", orgId: null };

export type ScopeSkip =
  | "no-blocks"
  | "unlicensed"
  | "unreadable"
  | "too-few-analysable-blocks";

export type ScopeAnalysis = {
  slug: string;
  skillId: string;
  skillVersionId: string;
  scope: ScopeReport;
  disclosure: DisclosureReport;
  /** Block ids in document order, so the stored clusters resolve back to passages. */
  blockIds: string[];
  types: Array<string | null>;
  /**
   * The block vectors, returned and never stored.
   *
   * Only `calibrateScope` reads them: it pairs two documents' blocks into a synthetic two-skill
   * document, and re-embedding the same text to do that would double the bill of the one command
   * whose entire job is to stay cheap enough to re-run while a threshold is being tuned. Nothing
   * persists them — see the table comment on why 1.6 million block vectors is not a schema.
   */
  vectors: number[][];
  inputTokens: number;
};

export type ScopeOutcome =
  | { ok: true; analysis: ScopeAnalysis }
  | { ok: false; slug: string; skip: ScopeSkip };

type BlockRow = {
  id: string;
  type: string | null;
  start_char: number;
  end_char: number;
  word_count: number;
  token_estimate: number;
  marker_path: string | null;
  content_hash: string;
  content_stored: boolean;
  redistribution: string;
  skill_id: string;
  slug: string;
  org_id: string | null;
  body_bytes: number;
};

/**
 * Analyse one version. Costs one embedding call.
 *
 * Every early return names its reason rather than returning an empty report, because *"we could
 * not read this"* and *"this is one coherent skill"* are the two answers a caller must never
 * confuse — and they would look identical as a null verdict.
 */
export async function analyseSkillScope(skillVersionId: string): Promise<ScopeOutcome> {
  const { rows } = await db.execute<BlockRow>(sql`
    select b.id, b.type, b.start_char, b.end_char, b.word_count, b.token_estimate,
           st.marker_path, v.content_hash, v.content_stored, v.redistribution,
           s.id as skill_id, s.slug, s.org_id,
           coalesce(st.body_bytes, 0) as body_bytes
      from skill_blocks b
      join skill_versions v on v.id = b.skill_version_id
      join skills s on s.id = b.skill_id
      left join skill_structures st
        on st.skill_version_id = b.skill_version_id
       and st.extractor_version = ${EXTRACTOR_VERSION}
     where b.skill_version_id = ${skillVersionId}
       and b.extractor_version = ${EXTRACTOR_VERSION}
     order by b.block_order asc
  `);

  if (rows.length === 0) return { ok: false, slug: "", skip: "no-blocks" };

  const first = rows[0];
  /*
   * Checked before any object is read, the same order `exportSkill` uses — and the distinction
   * is worth stating precisely, because it is not the block library's gate.
   *
   * Analysing unlicensed content is **allowed**: `metadata_only` and `unresolved` skills are
   * validated, fingerprinted and block-extracted today, and their rows are counted by the
   * miner. What is not allowed is *copying* them, so their bytes were never stored — which
   * means there is nothing here to read. The refusal is a consequence of the licence rather
   * than a licence decision, and only bytes we were permitted to keep ever reach the model.
   */
  if (!first.content_stored || !first.marker_path) {
    return { ok: false, slug: first.slug, skip: "unlicensed" };
  }

  /*
   * One fetch for the whole document, then N slices.
   *
   * `readFragment` would re-read the same object once per block — thirty-six round trips to an
   * EU bucket to analyse one skill. `readMarkerBody` is the same code with the loop lifted out,
   * and it still owns the single definition of where a body starts.
   */
  const body = await readMarkerBody(first.content_hash, first.marker_path);
  if (body === null) return { ok: false, slug: first.slug, skip: "unreadable" };

  const texts: string[] = [];
  const kept: BlockRow[] = [];
  for (const row of rows) {
    if (row.word_count < SCOPE_MIN_BLOCK_WORDS) continue;
    const text = body.slice(row.start_char, row.end_char).trim();
    if (text.length > 0) {
      texts.push(text);
      kept.push(row);
    }
  }

  if (texts.length === 0) return { ok: false, slug: first.slug, skip: "unreadable" };
  if (kept.length < MIN_BLOCKS_TO_JUDGE) {
    /*
     * Reported as a skip rather than as `not-measurable`, because the two have different
     * causes: this document may be long and mostly made of short blocks, where the verdict
     * form would claim we looked at a short document. The CLI counts them apart.
     */
    return { ok: false, slug: first.slug, skip: "too-few-analysable-blocks" };
  }

  const { vectors, inputTokens } = await embedBatch(texts, SCOPE_EMBED_SCOPE);

  const types = kept.map((row) => row.type);
  const scope = analyseCohesion({ vectors, types });
  const disclosure = analyseDisclosure({
    vectors,
    types,
    words: kept.map((row) => row.word_count),
    tokens: kept.map((row) => row.token_estimate),
    bodyBytes: first.body_bytes,
    /* The validator's own threshold, imported. Never a second opinion about "too big". */
    hintBytes: DISCLOSURE_HINT_BYTES,
  });

  return {
    ok: true,
    analysis: {
      slug: first.slug,
      skillId: first.skill_id,
      skillVersionId,
      scope,
      disclosure,
      blockIds: kept.map((row) => row.id),
      types,
      vectors,
      inputTokens,
    },
  };
}

/** Persist a verdict. Replaces the row for this (version, analyser) pair rather than appending. */
export async function storeScope(analysis: ScopeAnalysis, orgId: string | null = null): Promise<void> {
  const [a, b] = analysis.scope.clusters;
  await db
    .insert(skillScope)
    .values({
      orgId,
      skillId: analysis.skillId,
      skillVersionId: analysis.skillVersionId,
      analyserVersion: SCOPE_ANALYSER_VERSION,
      embedderVersion: BLOCK_EMBEDDER_VERSION,
      blocks: analysis.scope.blocks,
      cohesion: analysis.scope.cohesion,
      separation: analysis.scope.separation,
      type_purity: analysis.scope.typePurity,
      verdict: analysis.scope.verdict,
      /* Ids, never text — this table holds no body content, same rule as `skill_blocks`. */
      clusters: {
        a: a.map((i) => analysis.blockIds[i]),
        b: b.map((i) => analysis.blockIds[i]),
        aTypes: a.map((i) => analysis.types[i]),
        bTypes: b.map((i) => analysis.types[i]),
      },
      bodyBytes: analysis.disclosure.bodyBytes,
      oversized: analysis.disclosure.oversized,
      movableTokens: analysis.disclosure.movableTokens,
      candidates: analysis.disclosure.candidates.map((candidate) => ({
        blockId: analysis.blockIds[candidate.index],
        words: candidate.words,
        tokens: candidate.tokens,
        centrality: Math.round(candidate.centrality * 1000) / 1000,
        type: candidate.type,
      })),
    })
    .onConflictDoUpdate({
      target: [skillScope.skillVersionId, skillScope.analyserVersion],
      set: {
        embedderVersion: BLOCK_EMBEDDER_VERSION,
        blocks: analysis.scope.blocks,
        cohesion: analysis.scope.cohesion,
        separation: analysis.scope.separation,
        type_purity: analysis.scope.typePurity,
        verdict: analysis.scope.verdict,
        bodyBytes: analysis.disclosure.bodyBytes,
        oversized: analysis.disclosure.oversized,
        movableTokens: analysis.disclosure.movableTokens,
        at: new Date(),
      },
    });
}

export type ScopeRunReport = {
  analysed: number;
  stored: number;
  skipped: Record<ScopeSkip, number>;
  verdicts: Record<ScopeVerdict, number>;
  inputTokens: number;
  /** The finding, printed rather than buried: which skills the analyser wants split. */
  splitCandidates: Array<{ slug: string; separation: number; typePurity: number | null }>;
  oversizedFound: number;
  movableTokens: number;
};

/**
 * Run over a bounded slice of the public corpus.
 *
 * **Resumable and never scheduled.** The selector is "no row at the current analyser version",
 * so a re-run picks up where the last one stopped and charges nothing for what is done — the
 * same shape as `embeddings --backfill`, and the same standing rule: a job that spends is a job
 * nobody can leave switched on.
 *
 * Sequential, like the A6 backfill and for the identical reason: parallel batches all clear
 * `assertWithinBudget` before any cost is recorded, which breaks the one-call overshoot bound
 * RC.2's check-before / ledger-after ordering rests on.
 */
export async function runScopeAnalysis(limit: number): Promise<ScopeRunReport> {
  const rows = (await pendingScopeVersions(limit)).map((id) => ({ id }));

  const report: ScopeRunReport = {
    analysed: 0,
    stored: 0,
    skipped: { "no-blocks": 0, unlicensed: 0, unreadable: 0, "too-few-analysable-blocks": 0 },
    verdicts: { cohesive: 0, "split-candidate": 0, "type-aligned": 0, "not-measurable": 0 },
    inputTokens: 0,
    splitCandidates: [],
    oversizedFound: 0,
    movableTokens: 0,
  };

  for (const row of rows) {
    const outcome = await analyseSkillScope(row.id);
    report.analysed += 1;
    if (!outcome.ok) {
      report.skipped[outcome.skip] += 1;
      continue;
    }
    const { analysis } = outcome;
    report.inputTokens += analysis.inputTokens;
    report.verdicts[analysis.scope.verdict] += 1;
    if (analysis.scope.verdict === "split-candidate") {
      report.splitCandidates.push({
        slug: analysis.slug,
        separation: Math.round((analysis.scope.separation ?? 0) * 1000) / 1000,
        typePurity:
          analysis.scope.typePurity === null
            ? null
            : Math.round(analysis.scope.typePurity * 1000) / 1000,
      });
    }
    if (analysis.disclosure.oversized) {
      report.oversizedFound += 1;
      report.movableTokens += analysis.disclosure.movableTokens;
    }
    await storeScope(analysis);
    report.stored += 1;
  }

  return report;
}

/**
 * Versions with no verdict at the current analyser version.
 *
 * **Its own exported function so that something can run it.** The first version of this query
 * joined `skills` on `v.current_version_id`, a column that lives on `skills` and not on
 * `skill_versions` — nonsense that typechecks, because a `sql` template is a string. It reached a
 * live run and died on `column v.current_version_id does not exist`, having cost nothing but
 * looking like a broken feature.
 *
 * Nothing could have caught it: the suite's stored-rows half skipped while the table did not
 * exist, and even afterwards it asserted on schema and on data and never *executed the selector*.
 * A check that cannot observe the failure is not evidence, so `verify:scope` now calls this
 * directly — free, because a selector returns ids and embeds nothing.
 */
export async function pendingScopeVersions(limit: number): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select v.id
      from skill_versions v
      /* The skill's current version only. The current_version_id column lives on skills. */
      join skills s on s.id = v.skill_id and s.current_version_id = v.id
     where s.status = 'indexed'
       and s.org_id is null
       and s.canonical_skill_id is null
       and v.content_stored = true
       and not exists (
         select 1 from skill_scope sc
          where sc.skill_version_id = v.id
            and sc.analyser_version = ${SCOPE_ANALYSER_VERSION}
       )
     limit ${limit}
  `);
  return rows.map((row) => row.id);
}

/**
 * Coverage and the corpus finding, in one query.
 *
 * Coverage leads, because *"three skills should be split"* over a corpus 0.4% analysed reads as
 * a clean corpus, and that is the `archetypes --blocks` misreading in a new place.
 */
export async function scopeSummary() {
  const [coverage] = await db
    .select({
      analysed: sql<number>`count(*)::int`,
      current: sql<number>`count(*) filter (where ${skillScope.analyserVersion} = ${SCOPE_ANALYSER_VERSION})::int`,
    })
    .from(skillScope);

  const { rows: totals } = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
      from skills s
     where s.status = 'indexed' and s.org_id is null and s.canonical_skill_id is null
  `);
  const total = totals[0]?.total ?? 0;

  const { rows: verdicts } = await db.execute<{ verdict: string; n: number }>(sql`
    select verdict, count(*)::int as n
      from skill_scope
     where analyser_version = ${SCOPE_ANALYSER_VERSION}
     group by verdict
  `);

  const { rows: disclosure } = await db.execute<{
    oversized: number;
    movable: number;
    with_candidates: number;
  }>(sql`
    select count(*) filter (where oversized)::int as oversized,
           coalesce(sum(movable_tokens), 0)::int as movable,
           count(*) filter (where jsonb_array_length(candidates) > 0)::int as with_candidates
      from skill_scope
     where analyser_version = ${SCOPE_ANALYSER_VERSION}
  `);

  return {
    analysed: coverage?.current ?? 0,
    rowsAllVersions: coverage?.analysed ?? 0,
    total,
    verdicts,
    disclosure: disclosure[0] ?? { oversized: 0, movable: 0, with_candidates: 0 },
    analyserVersion: SCOPE_ANALYSER_VERSION,
    embedderVersion: BLOCK_EMBEDDER_VERSION,
    model: EMBEDDING_MODEL,
  };
}

/** The stored verdict for one skill, for the CLI and — later — a page. */
export async function scopeFor(skillVersionId: string) {
  const [row] = await db
    .select()
    .from(skillScope)
    .where(
      and(
        eq(skillScope.skillVersionId, skillVersionId),
        eq(skillScope.analyserVersion, SCOPE_ANALYSER_VERSION),
      ),
    )
    .limit(1);
  return row ?? null;
}

/* -------------------------------------------------------------- calibration */

export type CalibrationSample = { slug: string; separation: number; purityNull: boolean };

export type CalibrationReport = {
  /** Real corpus documents, each measured alone. The "one skill, probably" population. */
  single: CalibrationSample[];
  /**
   * Two unrelated skills' blocks concatenated. The "definitely two skills" population.
   *
   * An **upper bound**, and the report says so: a real two-subject skill is written by one
   * author in one voice about two jobs that felt related enough to combine, so its seam is
   * necessarily softer than a seam between two strangers' documents. If the corpus population
   * sits close to this one, the metric cannot discriminate at all.
   */
  paired: CalibrationSample[];
  /** How often the type-confound guard could not run, because a cluster was mostly untyped. */
  purityNullRate: number;
  inputTokens: number;
};

/**
 * Give `separation` two reference points, because on its own it has none.
 *
 * The first corpus run returned **51% split candidates at 0.22**, which is not a finding about
 * the corpus — it is a threshold with nothing behind it. Every value landed between 0.22 and
 * 0.48 and there was no way to know which end meant anything.
 *
 * This is the control that was missing. Two unrelated skills glued together is a document that
 * genuinely *is* two skills, so its separation is what the metric should be able to reach; a
 * single real document is what it should usually not. Where those two distributions stop
 * overlapping is where the threshold belongs, and if they never stop overlapping then RW.10
 * cannot be built on this measurement and that is worth knowing before it reaches an author.
 *
 * Each skill is embedded **once** and used in both populations, so the control costs no more
 * than measuring the sample.
 */
export async function calibrateScope(sampleSize: number): Promise<CalibrationReport> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select v.id
      from skill_versions v
      join skills s on s.id = v.skill_id and s.current_version_id = v.id
     where s.status = 'indexed'
       and s.org_id is null
       and s.canonical_skill_id is null
       and v.content_stored = true
     order by random()
     limit ${sampleSize}
  `);

  type Embedded = { slug: string; vectors: number[][]; types: Array<string | null> };
  const embedded: Embedded[] = [];
  let inputTokens = 0;

  for (const row of rows) {
    const outcome = await analyseSkillScope(row.id);
    if (!outcome.ok) continue;
    inputTokens += outcome.analysis.inputTokens;
    /*
     * `analyseSkillScope` drops its vectors, so the pairing needs them again. Re-embedding the
     * same text would double the bill of the one command whose whole job is to be cheap enough
     * to re-run while tuning, so the vectors come back on the analysis for this caller only.
     */
    embedded.push({
      slug: outcome.analysis.slug,
      vectors: outcome.analysis.vectors,
      types: outcome.analysis.types,
    });
  }

  const single: CalibrationSample[] = [];
  let nullPurity = 0;
  for (const item of embedded) {
    const report = analyseCohesion({ vectors: item.vectors, types: item.types });
    if (report.separation === null) continue;
    if (report.typePurity === null) nullPurity += 1;
    single.push({
      slug: item.slug,
      separation: report.separation,
      purityNull: report.typePurity === null,
    });
  }

  /*
   * Paired against the other half of the sample, so no skill is paired with itself and every
   * pair is two documents chosen independently at random from 47,854.
   */
  const paired: CalibrationSample[] = [];
  const half = Math.floor(embedded.length / 2);
  for (let i = 0; i < half; i += 1) {
    const a = embedded[i];
    const b = embedded[i + half];
    const report = analyseCohesion({
      vectors: [...a.vectors, ...b.vectors],
      types: [...a.types, ...b.types],
    });
    if (report.separation === null) continue;
    paired.push({
      slug: `${a.slug} + ${b.slug}`,
      separation: report.separation,
      purityNull: report.typePurity === null,
    });
  }

  return {
    single,
    paired,
    purityNullRate: single.length === 0 ? 0 : nullPurity / single.length,
    inputTokens,
  };
}
