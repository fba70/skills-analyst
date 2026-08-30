import "dotenv/config";

import {
  decideCandidates,
  enrichCandidates,
  promotionSummary,
  reapplyMarkerThreshold,
  reapplyPathExclusions,
} from "../src/server/crawl/promote";

/**
 * Turns discovered repositories into syncable sources.
 *
 *   pnpm promote --status            # counts only
 *   pnpm promote --enrich 50         # fetch metadata for 50 candidates
 *   pnpm promote --decide            # apply the policy (offline, re-runnable)
 *   pnpm promote --reapply           # re-judge held rows after a policy threshold changed
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(`--${flag}`);
  return index >= 0 ? Number(args[index + 1]) : undefined;
};

async function status() {
  const { rows, review } = await promotionSummary();
  console.info("\nDiscovered repositories");
  for (const row of rows.sort((a, b) => b.count - a.count)) {
    console.info(`  ${row.status.padEnd(14)} ${String(row.count).padStart(5)}`);
  }
  if (review.length > 0) {
    console.info("\nHeld for review (largest first)");
    for (const row of review) {
      console.info(
        `  ${row.name.padEnd(46)} ${String(row.hitCount).padStart(5)} markers  ` +
          `${String(row.stars ?? "—").padStart(6)} stars  ${row.reason ?? ""}`,
      );
    }
  }
  console.info("");
}

if (args.includes("--status")) {
  await status();
  process.exit(0);
}

const reapplied = await reapplyPathExclusions();
if (reapplied > 0) console.info(`re-applied path exclusions to ${reapplied} candidate(s)`);

if (args.includes("--reapply")) {
  // Offline and free, so it is safe to run after any threshold change in either direction.
  const marker = await reapplyMarkerThreshold();
  console.info(
    `marker threshold: re-enabled ${marker.reEnabled} source(s), ${marker.stillHeld} still held`,
  );
}

if (args.includes("--enrich")) {
  const report = await enrichCandidates(value("enrich") ?? 50);
  console.info(
    `enriched ${report.enriched}, unavailable ${report.missing}, failed ${report.failed}`,
  );
}

if (args.includes("--decide")) {
  const report = await decideCandidates();
  console.info(
    `\npromoted ${report.promoted} · held for review ${report.review} · skipped ${report.skipped}`,
  );
  console.info("\nreasons");
  for (const [reason, count] of Object.entries(report.byReason).sort((a, b) => b[1] - a[1])) {
    console.info(`  ${String(count).padStart(4)}  ${reason}`);
  }
}

await status();
