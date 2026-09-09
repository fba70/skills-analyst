import "dotenv/config";

import {
  MAX_TYPE_PURITY,
  MIN_BLOCKS_TO_JUDGE,
  MIN_SPLIT_SEPARATION,
  SCOPE_ANALYSER_VERSION,
  SCOPE_VERDICT_META,
  type ScopeVerdict,
} from "../src/lib/scope";
import { DISCLOSURE_HINT_BYTES, formatTokens } from "../src/lib/tokens";
import { rateFor } from "../src/lib/llm-pricing";
import { EMBEDDING_MODEL } from "../src/server/analytics/embeddings";
import {
  analyseSkillScope,
  BLOCK_EMBEDDER_VERSION,
  calibrateScope,
  runScopeAnalysis,
  scopeSummary,
} from "../src/server/analytics/scope";

/**
 * Scope analysis and disclosure restructuring (Doc 6 RW.10 / RW.11, plan step C5).
 *
 *   pnpm scope --status         coverage, and the corpus finding so far — free
 *   pnpm scope --run 200        analyse N unanalysed skills — COSTS MONEY (embeddings)
 *   pnpm scope --skill <slug>   analyse one named skill and print it — COSTS A FRACTION OF A CENT
 *   pnpm scope --calibrate 60   give the separation threshold two reference points — COSTS ~$0.002
 *
 * **Pointed at the corpus before it is pointed at a draft**, which is what the plan asks for and
 * is the whole reason this is a CLI first. Telling an author to cut their document in half is
 * the most expensive advice this platform can give; the cheapest way to find out whether the
 * metric earns that is to run it over documents nobody will be upset about and read the output.
 *
 * Never scheduled. It spends, and the standing rule is that a job which spends is a job nobody
 * can leave switched on.
 */

const args = process.argv.slice(2);
const numberAfter = (flag: string, fallback: number) => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

/** The real rate for the real model — never a remembered number. */
const usd = (tokens: number) =>
  (tokens / 1_000_000) * rateFor(EMBEDDING_MODEL).inputPerMTok;

if (args.includes("--calibrate")) {
  const sampleSize = numberAfter("--calibrate", 60);
  console.info(
    `\nCalibrating separation against ${sampleSize} random skills and the same skills paired…\n`,
  );

  const report = await calibrateScope(sampleSize);
  const pct = (values: number[], p: number) => {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };
  const singles = report.single.map((s) => s.separation);
  const pairs = report.paired.map((s) => s.separation);

  const row = (label: string, values: number[]) =>
    console.info(
      `    ${label.padEnd(22)} n=${String(values.length).padStart(3)}  ` +
        `p10 ${pct(values, 10).toFixed(3)}  p50 ${pct(values, 50).toFixed(3)}  ` +
        `p90 ${pct(values, 90).toFixed(3)}  max ${Math.max(...values).toFixed(3)}`,
    );

  console.info("  Separation");
  row("one real document", singles);
  row("two skills, glued", pairs);

  /*
   * The number that decides whether RW.10 is buildable on this measurement.
   *
   * Overlap is the share of real single documents that score at or above the median glued pair.
   * Near zero and there is a clean threshold between them; near a half and the metric cannot
   * tell a two-subject document from an ordinary one, and no threshold rescues that.
   */
  const pairedMedian = pct(pairs, 50);
  const overlap = singles.filter((value) => value >= pairedMedian).length / Math.max(1, singles.length);
  console.info(
    `\n    ${(overlap * 100).toFixed(0)}% of real single documents score at or above the ` +
      `median glued pair (${pairedMedian.toFixed(3)}).`,
  );
  console.info(
    overlap < 0.1
      ? "    The two populations separate. A threshold between them is defensible."
      : "    The two populations overlap. Read this as the metric failing, not the corpus.",
  );

  console.info(
    `\n    The type-confound guard could not run on ${(report.purityNullRate * 100).toFixed(0)}% ` +
      `of documents\n    (a cluster was mostly unclassified, and 58% of corpus blocks carry no type).`,
  );
  console.info(`\n  ${report.inputTokens.toLocaleString()} tokens · $${usd(report.inputTokens).toFixed(4)}\n`);
  process.exit(0);
}

if (args.includes("--skill")) {
  const slug = valueAfter("--skill");
  const { db } = await import("../src/server/db");
  const { sql } = await import("drizzle-orm");
  const { rows } = await db.execute<{ id: string; name: string }>(sql`
    select v.id, s.name
      from skills s join skill_versions v on v.id = s.current_version_id
     where s.slug = ${slug ?? ""}
     limit 1
  `);
  if (rows.length === 0) {
    console.error(`No indexed skill with the slug ${slug}.`);
    process.exit(1);
  }

  const outcome = await analyseSkillScope(rows[0].id);
  if (!outcome.ok) {
    console.info(`\n  ${rows[0].name}\n  skipped: ${outcome.skip}\n`);
    process.exit(0);
  }

  const { scope, disclosure, types, inputTokens } = outcome.analysis;
  const meta = SCOPE_VERDICT_META[scope.verdict];
  console.info(`\n  ${rows[0].name}\n`);
  console.info(`  ${meta.label} — ${meta.blurb}\n`);
  console.info(`    blocks analysed  ${scope.blocks}`);
  console.info(`    cohesion         ${scope.cohesion.toFixed(3)}  (mean pairwise cosine)`);
  console.info(
    `    separation       ${scope.separation === null ? "—" : scope.separation.toFixed(3)}` +
      `  (threshold ${MIN_SPLIT_SEPARATION})`,
  );
  console.info(
    `    type purity      ${scope.typePurity === null ? "— (mostly unclassified)" : scope.typePurity.toFixed(3)}` +
      `  (a split above ${MAX_TYPE_PURITY} is block type, not scope)`,
  );

  if (scope.clusters[0].length > 0) {
    const label = (indices: number[]) => {
      const counts = new Map<string, number>();
      for (const i of indices) counts.set(types[i] ?? "unclassified", (counts.get(types[i] ?? "unclassified") ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t}×${n}`).join(", ");
    };
    console.info(`\n    group A (${scope.clusters[0].length})  ${label(scope.clusters[0])}`);
    console.info(`    group B (${scope.clusters[1].length})  ${label(scope.clusters[1])}`);
  }

  console.info(`\n  Disclosure (RW.11)`);
  console.info(
    `    body ${disclosure.bodyBytes.toLocaleString()} bytes` +
      ` · hint at ${DISCLOSURE_HINT_BYTES.toLocaleString()}` +
      ` · ${disclosure.oversized ? "over" : "under, nothing to propose"}`,
  );
  if (disclosure.candidates.length > 0) {
    console.info(
      `    ${disclosure.candidates.length} block(s) could move to references/, returning ` +
        `${formatTokens(disclosure.movableTokens)} per activation`,
    );
    for (const candidate of disclosure.candidates.slice(0, 8)) {
      console.info(
        `      ${String(candidate.words).padStart(4)}w  centrality ${candidate.centrality.toFixed(3)}  ` +
          `${candidate.type ?? "unclassified"}`,
      );
    }
  }
  console.info(`\n  ${inputTokens.toLocaleString()} tokens embedded\n`);
  process.exit(0);
}

if (args.includes("--run")) {
  const limit = numberAfter("--run", 100);
  console.info(
    `\nAnalysing up to ${limit} skill(s) at analyser ${SCOPE_ANALYSER_VERSION}, ` +
      `embedder ${BLOCK_EMBEDDER_VERSION}…\n`,
  );

  const report = await runScopeAnalysis(limit);
  const spent = usd(report.inputTokens);

  console.info(
    `  ${report.analysed} examined · ${report.stored} stored · ` +
      `${report.inputTokens.toLocaleString()} tokens · $${spent.toFixed(4)}\n`,
  );

  console.info("  Verdicts");
  for (const [verdict, n] of Object.entries(report.verdicts)) {
    if (n === 0) continue;
    console.info(`    ${verdict.padEnd(18)} ${String(n).padStart(5)}`);
  }

  const skipped = Object.entries(report.skipped).filter(([, n]) => n > 0);
  if (skipped.length > 0) {
    /*
     * Printed apart from the verdicts, never added to them. A skill we could not read and a
     * skill that reads as one subject are opposite facts, and one table would let the first
     * quietly reassure somebody about the second.
     */
    console.info("\n  Not judged");
    for (const [reason, n] of skipped) console.info(`    ${reason.padEnd(28)} ${String(n).padStart(5)}`);
  }

  if (report.splitCandidates.length > 0) {
    console.info("\n  Possibly two skills — read these before believing the metric");
    for (const candidate of report.splitCandidates.slice(0, 20)) {
      console.info(
        `    sep ${candidate.separation.toFixed(3)}  ` +
          `purity ${candidate.typePurity === null ? " —  " : candidate.typePurity.toFixed(3)}  ` +
          candidate.slug,
      );
    }
  }

  console.info(
    `\n  Disclosure: ${report.oversizedFound} oversized document(s), ` +
      `${formatTokens(report.movableTokens)} movable in total\n`,
  );
  process.exit(0);
}

/* Default: status. Free. */
const summary = await scopeSummary();
const remaining = Math.max(0, summary.total - summary.analysed);

console.info("\nScope and disclosure (RW.10 / RW.11)\n");
console.info(`  analyser ${summary.analyserVersion} · embedder ${summary.embedderVersion}`);
console.info(
  `  ${summary.analysed.toLocaleString()} of ${summary.total.toLocaleString()} indexed public skills ` +
    `analysed (${summary.total === 0 ? 0 : Math.round((summary.analysed / summary.total) * 100)}%)`,
);

/*
 * Coverage leads, and the finding is withheld under it.
 *
 * "Three skills should be split" over a corpus 0.4% analysed reads as a clean corpus, which is
 * the `archetypes --blocks` misreading in a new place: the same output, the opposite conclusion.
 */
if (summary.analysed === 0) {
  console.info("\n  Nothing analysed yet. `pnpm scope --run 200` — COSTS MONEY, a few cents.\n");
  process.exit(0);
}

console.info("\n  Verdicts");
const byVerdict = new Map(summary.verdicts.map((row) => [row.verdict, row.n]));
for (const verdict of Object.keys(SCOPE_VERDICT_META) as ScopeVerdict[]) {
  const n = byVerdict.get(verdict) ?? 0;
  const share = summary.analysed === 0 ? 0 : Math.round((n / summary.analysed) * 100);
  console.info(`    ${verdict.padEnd(18)} ${String(n).padStart(6)}  ${String(share).padStart(3)}%`);
}

/*
 * A finding that fires on half the population is not a finding.
 *
 * The first corpus run came back 51% split-candidate at a threshold nothing had validated, and
 * a table of verdicts printed without this line would have read as a discovery about the corpus.
 * Same refusal as `archetypes --blocks`, which prints coverage and the unmet threshold instead of
 * eleven rows of zeros: the command whose job is to decide whether a feature gets built must not
 * hand back a confident wrong answer.
 */
const splitShare =
  summary.analysed === 0 ? 0 : (byVerdict.get("split-candidate") ?? 0) / summary.analysed;
if (splitShare > 0.25) {
  console.info(
    `\n  ⚠ ${Math.round(splitShare * 100)}% of judged documents are split candidates. Read that as ` +
      `the\n    threshold being uncalibrated rather than as a fact about the corpus — a seam that ` +
      `is\n    everywhere is not a seam. pnpm scope --calibrate 60`,
  );
}

console.info("\n  Disclosure");
console.info(`    oversized bodies       ${String(summary.disclosure.oversized).padStart(6)}`);
console.info(`    with movable blocks    ${String(summary.disclosure.with_candidates).padStart(6)}`);
console.info(`    movable, in total      ${formatTokens(summary.disclosure.movable)}`);

console.info(
  `\n  A document needs ${MIN_BLOCKS_TO_JUDGE}+ analysable blocks to be judged at all, and a ` +
    `split needs\n  separation ≥ ${MIN_SPLIT_SEPARATION} that block type does not explain ` +
    `(purity ≤ ${MAX_TYPE_PURITY}).`,
);
console.info(`\n  ${remaining.toLocaleString()} still to analyse. pnpm scope --run 200\n`);
process.exit(0);
