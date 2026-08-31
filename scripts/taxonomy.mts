import "dotenv/config";

import { DEFAULT_BATCH, MAX_BATCH, MODEL } from "../src/server/taxonomy/classify";
import {
  ARCHETYPE_THRESHOLD,
  classifySample,
  resyncCategoryArrays,
  reviewQueue,
  sweepNotClassifiable,
  taxonomySummary,
} from "../src/server/taxonomy/run";
import { REVIEW_FLOOR, labelFor } from "../src/server/taxonomy/vocabulary";

/**
 * Category classification (Doc 2 R3.1).
 *
 *   pnpm taxonomy --status
 *   pnpm taxonomy --sample 20                  # classify 20 skills, spread across the corpus
 *   pnpm taxonomy --sample 20 --strategy top-quality
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
  const { counts, totals, readyForArchetype, remaining } = await taxonomySummary();

  console.info("\nTaxonomy coverage");
  console.info(`  skills labelled   ${totals.skillsLabelled}`);
  console.info(`  assignments       ${totals.assignments}`);
  console.info(`  held for review   ${totals.held}  (confidence < ${REVIEW_FLOOR})`);
  console.info(`  curator-reviewed  ${totals.reviewed}`);
  console.info(`  not yet labelled  ${remaining}`);
  console.info(
    `  archetype-ready   ${readyForArchetype} function categories at >= ${ARCHETYPE_THRESHOLD} confident skills`,
  );

  for (const axis of ["function", "domain"] as const) {
    const rows = counts.filter((c) => c.axis === axis);
    if (rows.length === 0) continue;
    console.info(`\n${axis.toUpperCase()} axis`);
    for (const row of rows) {
      const ready = axis === "function" && row.confident >= ARCHETYPE_THRESHOLD ? " ✓" : "";
      console.info(
        `  ${labelFor(axis, row.value).padEnd(28)} ${String(row.confident).padStart(4)} confident ` +
          `(${String(row.total).padStart(4)} total, avg conf ${row.avgConfidence})${ready}`,
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
  console.info(
    `\nClassifying ${limit} skill(s) with ${MODEL} · strategy ${strategy ?? "diverse"}`,
  );

  const report = await classifySample({
    limit,
    strategy,
    force: args.includes("--force"),
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
