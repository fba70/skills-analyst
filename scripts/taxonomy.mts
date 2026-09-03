import "dotenv/config";

import { DEFAULT_BATCH, MAX_BATCH, MODEL } from "../src/server/taxonomy/classify";
import { MIN_BAND, MIN_SOURCES, MIN_STRUCTURES } from "../src/server/analytics/archetype";
import {
  classifySample,
  resyncCategoryArrays,
  reviewQueue,
  sweepNotClassifiable,
  taxonomySummary,
  versionComparison,
} from "../src/server/taxonomy/run";
import { REVIEW_FLOOR, labelFor } from "../src/server/taxonomy/vocabulary";

/**
 * Category classification (Doc 2 R3.1).
 *
 *   pnpm taxonomy --status
 *   pnpm taxonomy --sample 20                  # classify 20 skills, spread across the corpus
 *   pnpm taxonomy --sample 20 --strategy top-quality
 *   pnpm taxonomy --sample 300 --relabel       # only skills labelled under an older version
 *   pnpm taxonomy --compare                    # did the vocabulary change help? (free)
 *   pnpm taxonomy --sweep [--dry]              # clear rows nothing can decide (free)
 *   pnpm taxonomy --review                     # the low-confidence queue, page 1
 *   pnpm taxonomy --review 4                   # page 4 of it (20 per page)
 *   pnpm taxonomy --resync                     # recompute skills.categories (free)
 *
 * **This is the one command in the repo that spends money.** It is a sample tool on
 * purpose: read the labels it produces, disagree with some, change a category description
 * in `vocabulary.ts`, run it again. Only once the labels look right is a wider run worth
 * paying for. `MAX_BATCH` (${MAX_BATCH}) is a fuse, not a setting.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(`--${flag}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const number = (flag: string) => {
  const raw = Number(value(flag));
  return Number.isFinite(raw) ? raw : undefined;
};

async function status() {
  const { counts, totals, evidence, readyForArchetype, remaining } = await taxonomySummary();
  const byCategory = new Map(evidence.map((e) => [e.category, e]));

  console.info("\nTaxonomy coverage");
  console.info(`  skills labelled   ${totals.skillsLabelled}`);
  console.info(`  assignments       ${totals.assignments}`);
  console.info(`  held for review   ${totals.held}  (confidence < ${REVIEW_FLOOR})`);
  console.info(`  curator-reviewed  ${totals.reviewed}`);
  console.info(`  not yet labelled  ${remaining}`);
  console.info(
    `  minable           ${readyForArchetype} function categories clear the evidence gate ` +
      `(>= ${MIN_STRUCTURES} structures, >= ${MIN_SOURCES} sources, >= ${MIN_BAND} in each band)`,
  );

  for (const axis of ["function", "domain"] as const) {
    const rows = counts.filter((c) => c.axis === axis);
    if (rows.length === 0) continue;
    console.info(`\n${axis.toUpperCase()} axis`);
    for (const row of rows) {
      /**
       * Structures, not skills, and shown rather than only summarised.
       *
       * The confident-skill count is what the classifier produced; the structure count is
       * what the miner will read. Printing only the first and ticking on it announced
       * `automate-browser` as ready at 54 skills while the miner refused it at 46
       * structures. Both numbers are on the row now, so the gap is visible instead of
       * being a contradiction between two commands.
       */
      const e = axis === "function" ? byCategory.get(row.value) : undefined;
      const gated = e?.meetsGate ?? false;
      const detail = e
        ? ` · ${String(e.structures).padStart(3)} str / ${String(e.sources).padStart(2)} src / band ${String(e.strong).padStart(3)}v${String(e.weak).padStart(3)}${gated ? " ✓" : ""}`
        : "";
      console.info(
        `  ${labelFor(axis, row.value).padEnd(28)} ${String(row.confident).padStart(4)} confident ` +
          `(${String(row.total).padStart(4)} total, avg conf ${row.avgConfidence})${detail}`,
      );
    }
  }
  console.info("");
}

if (args.includes("--status")) {
  await status();
  process.exit(0);
}

if (args.includes("--resync")) {
  // Free: recomputes the denormalised array from stored assignments. No model call.
  const changed = await resyncCategoryArrays();
  console.info(`\nrecomputed categories for ${changed} skill(s)\n`);
  process.exit(0);
}

if (args.includes("--sweep")) {
  /**
   * Applies the classifiability rule to assignments made before it existed.
   *
   * A rule added after the fact is not finished until the rows decided before it are
   * re-judged — the same argument as `reapplyMarkerThreshold`. Free, offline and
   * re-runnable, so `--dry` first is cheap and tells you exactly what would go.
   */
  const dryRun = args.includes("--dry");
  const result = await sweepNotClassifiable({ dryRun });
  console.info(
    `\n${dryRun ? "would clear" : "cleared"} ${result.matched} assignment(s) ` +
      `across ${result.skills} skill(s) with no usable description`,
  );
  console.info(
    `${result.remainingHeld} held assignment(s) remain — ordinary descriptions the ` +
      `classifier was unsure about, which no rule can decide.\n`,
  );
  process.exit(0);
}

if (args.includes("--review")) {
  /**
   * `--review N` is a **page**, not a row count.
   *
   * It used to mean "print N rows", which stopped being expressible once the queue became
   * paged: `pageWindow` clamps to the shared admin page sizes, so `--review 3` silently
   * printed 10. A flag that quietly ignores its argument is worse than one that changes
   * meaning, so it changed meaning — and the header now states the page, the slice and the
   * depth, none of which a row count could convey about a 1,130-deep queue.
   */
  // The largest shared page size: a terminal has room, and paging a 1,130-deep queue ten
  // rows at a time is not a serious way to read it.
  const queue = await reviewQueue({ page: number("review") ?? 1, pageSize: 20 });
  console.info(
    `\nLow-confidence queue — page ${queue.page} of ${queue.pageCount}, ` +
      `showing ${queue.items.length} of ${queue.total}, worst first`,
  );
  for (const row of queue.items) {
    console.info(
      `\n  [${String(row.confidence).padStart(3)}] ${row.axis}: ${row.value}  —  ${row.slug}`,
    );
    console.info(`        ${(row.summary ?? "(no description)").slice(0, 140)}`);
    if (row.rationale) console.info(`        why: ${row.rationale}`);
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--compare")) {
  /**
   * Free. Reads stored assignments and compares each skill against itself.
   *
   * Paired on purpose — see `versionComparison`. Batch-to-batch comparison confounds the
   * vocabulary change with a different sample, and when 1.2.0 landed it produced a 1.6-sigma
   * "regression" that was really sample mix.
   */
  const c = await versionComparison();
  if (!c.priorVersion) {
    console.info(`\nNothing to compare — every assignment is at ${c.currentVersion}.\n`);
    process.exit(0);
  }

  console.info(
    `\n${c.priorVersion} → ${c.currentVersion}, ${c.pairedSkills} skill(s) carry both`,
  );

  if (!c.comparable && c.pairedSkills > 0) {
    console.error(`\nNOT COMPARABLE\n\n  ${c.reason}\n`);
    console.error(
      `  Use unpaired aggregates instead — and prefer the label *distribution* over the\n` +
        `  held rate, which is the part sample mix does not swamp. Giving this table real\n` +
        `  history means adding classifier_version to skill_categories_uq.\n`,
    );
    process.exit(1);
  }

  if (c.pairedSkills === 0) {
    console.info(
      `\nNo skill carries labels under both versions yet. Run ` +
        `pnpm taxonomy --sample N --relabel to build the paired set.\n`,
    );
    process.exit(0);
  }

  console.info("\naxis        assigns      avg conf         held");
  for (const a of c.axes) {
    console.info(
      `  ${a.axis.padEnd(9)} ${String(a.priorAssignments).padStart(4)} → ${String(a.currentAssignments).padEnd(5)} ` +
        `${String(a.priorAvgConfidence).padStart(3)} → ${String(a.currentAvgConfidence).padEnd(4)} ` +
        `${String(a.priorHeldPct).padStart(5)}% → ${String(a.currentHeldPct).padStart(5)}%` +
        `  (${a.priorHeld} → ${a.currentHeld})`,
    );
  }

  if (c.moved.length > 0) {
    console.info("\ncategories whose usage moved most:");
    for (const m of c.moved) {
      const delta = m.current - m.prior;
      console.info(
        `  ${m.axis.padEnd(9)} ${m.value.padEnd(24)} ${String(m.prior).padStart(4)} → ` +
          `${String(m.current).padStart(4)}  ${delta > 0 ? "+" : ""}${delta}`,
      );
    }
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--sample")) {
  const limit = number("sample") ?? DEFAULT_BATCH;
  if (limit > MAX_BATCH) {
    console.error(
      `\nRefusing: ${limit} is over the ${MAX_BATCH} cap. This run costs money per skill —\n` +
        `raise MAX_BATCH in src/server/taxonomy/classify.ts deliberately if that is intended.\n`,
    );
    process.exit(1);
  }

  const strategy = value("strategy") as "diverse" | "recent" | "top-quality" | undefined;
  /**
   * `--relabel` narrows the population to skills already labelled under an older
   * vocabulary version, so the batch is comparable to itself via `--compare`. Distinct
   * from `--force`, which re-does skills labelled at the *current* version.
   */
  const onlyPriorVersion = args.includes("--relabel");
  console.info(
    `\nClassifying ${limit} skill(s) with ${MODEL} · strategy ${strategy ?? "diverse"}` +
      `${onlyPriorVersion ? " · only skills labelled under an older version" : ""}`,
  );

  const report = await classifySample({
    limit,
    strategy,
    force: args.includes("--force"),
    onlyPriorVersion,
    onProgress: (m) => console.info(`  ${m}`),
  });

  console.info(
    `\nclassified ${report.classified}/${report.requested} · failed ${report.failed} · ` +
      `${report.assignments} assignment(s), ${report.held} held for review · ` +
      `${report.remaining} skill(s) still unlabelled`,
  );
  for (const error of report.errors) console.warn(`  failure: ${error}`);
  if (report.invalidIds.length > 0) {
    // A model inventing an id means the vocabulary prompt is ambiguous, not that the row
    // should be coerced into something near enough.
    console.warn(`  dropped invalid ids: ${report.invalidIds.join(", ")}`);
  }
}

await status();
process.exit(0);
