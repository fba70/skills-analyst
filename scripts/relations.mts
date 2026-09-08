import "dotenv/config";

import { CONFLICT_MINER_VERSION, CONFLICT_MIN_SIMILARITY, RELATION_META } from "../src/lib/relations";
import { mineConflicts } from "../src/server/analytics/conflicts";
import { relationSummary } from "../src/server/analytics/relations";

/**
 * The knowledge graph (Doc 6 RK.3, plan step E2).
 *
 *   pnpm relations --status        what is stored, and how much of it is current
 *   pnpm relations --conflicts 20  mine conflicts in N near-neighbour pairs — COSTS MONEY
 *
 * `--conflicts` is one model call per pair that survives three filters, billed to the platform
 * budget like every other corpus analyzer. Never scheduled, for the standing reason: a job that
 * spends is a job nobody can leave switched on.
 *
 * Only conflicts and declared edges are stored. Similarity comes from the A6 index and
 * supersession from `skills.superseded_by_skill_id`, both resolved live — so neither appears here
 * and neither can go stale.
 */

const args = process.argv.slice(2);
const numberAfter = (flag: string, fallback: number) => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

if (args.includes("--conflicts")) {
  const limit = numberAfter("--conflicts", 20);
  console.info(
    `Comparing guardrails in up to ${limit} near-neighbour pairs ` +
      `(similarity >= ${CONFLICT_MIN_SIMILARITY})…\n`,
  );
  const report = await mineConflicts({ limit });
  console.info(
    `  ${report.skillsExamined} skill(s) · ${report.pairsConsidered} pair(s) considered · ` +
      `${report.pairsCalled} sent to the model · ${report.conflictsFound} conflict(s) · ` +
      `$${(report.costMicros / 1_000_000).toFixed(4)}`,
  );
  /*
   * The gap between considered and called is the lexical filter earning its place. Printed
   * because it is the number that says whether the job is affordable at corpus scale, and it is
   * invisible from the outside otherwise.
   */
  if (report.pairsConsidered > report.pairsCalled) {
    console.info(
      `\n  ${report.pairsConsidered - report.pairsCalled} pair(s) shared no significant term and\n` +
        `  were not sent — guardrails about different objects cannot contradict.`,
    );
  }
} else {
  const summary = await relationSummary();

  console.info("\nKnowledge graph — stored edges\n");
  if (summary.rows.length === 0) {
    console.info("  Nothing stored yet. Run: pnpm relations --conflicts 20\n");
  } else {
    for (const row of summary.rows) {
      const label = RELATION_META[row.kind as keyof typeof RELATION_META]?.label ?? row.kind;
      console.info(`  ${label.padEnd(18)} ${String(row.n).padStart(6)}   ${row.source}`);
    }
  }

  console.info(
    `\n  mined at ${CONFLICT_MINER_VERSION}   ${summary.mined.current} of ${summary.mined.total}` +
      (summary.mined.total > summary.mined.current
        ? "   <- re-mine outstanding"
        : ""),
  );
  /*
   * Said every time, because a graph that looks this small invites the conclusion that the corpus
   * has no relationships. Two of the four kinds simply do not live here.
   */
  console.info(
    `\n  Similarity and supersession are not stored — they resolve live from the embedding\n` +
      `  index and from skills.superseded_by_skill_id, so they cannot go stale and do not\n` +
      `  appear in these counts.\n`,
  );
}

process.exit(0);
