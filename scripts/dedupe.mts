import "dotenv/config";

import {
  buildSignatures,
  clusterDuplicates,
  duplicateSummary,
  pendingSignatureCount,
  resetClusters,
} from "../src/server/analytics/dedupe";

/**
 * Near-duplicate detection.
 *
 *   pnpm duplicates --status
 *   pnpm duplicates --signatures 500   # pass 1: read bundles, store signatures
 *   pnpm duplicates --cluster          # pass 2: LSH + exact verify + cluster
 *
 * Named `duplicates`, not `dedupe`: pnpm has a built-in `dedupe` for the lockfile, and it
 * wins — running `pnpm dedupe` silently deduplicated node_modules instead.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(`--${flag}`);
  return index >= 0 ? Number(args[index + 1]) : undefined;
};

async function status() {
  const { counts, largest } = await duplicateSummary();
  const pending = await pendingSignatureCount();
  console.info("\nNear-duplicate detection");
  console.info(`  signatures        ${counts.signatures}`);
  console.info(`  awaiting          ${pending}`);
  console.info(`  canonical skills  ${counts.canonical}`);
  console.info(`  variants          ${counts.variants}`);
  console.info(`  duplicate links   ${counts.links}`);

  if (largest.length > 0) {
    console.info("\nLargest clusters");
    for (const row of largest) {
      console.info(
        `  ${String(row.variants).padStart(4)} variants  min ${row.minSimilarity.toFixed(3)}  ${row.name}`,
      );
    }
  }
  console.info("");
}

if (args.includes("--status")) {
  await status();
  process.exit(0);
}

if (args.includes("--signatures")) {
  const report = await buildSignatures({
    limit: value("signatures") ?? 500,
    onProgress: (m) => console.info(m),
  });
  console.info(
    `signatures: ${report.processed} built, ${report.skipped} skipped (empty), ${report.failed} failed`,
  );
}

if (args.includes("--recluster")) {
  // The rule changed, so previous decisions must be withdrawn before re-deciding.
  const cleared = await resetClusters();
  console.info(`cleared ${cleared} previous cluster link(s)`);
}

if (args.includes("--cluster") || args.includes("--recluster")) {
  const report = await clusterDuplicates({ onProgress: (m) => console.info(m) });
  console.info(
    `\ncandidates ${report.candidatePairs} · confirmed ${report.confirmed} · ` +
      `rejected as template siblings ${report.rejectedByDescription} · ` +
      `clusters ${report.clusters} · variants marked ${report.variantsMarked}`,
  );
}

await status();
