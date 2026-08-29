import "dotenv/config";

import { crawlCoverage, ensureSeedShards, runCrawl } from "../src/server/crawl/run";

/**
 * Runs a bounded slice of the open crawl.
 *
 *   pnpm crawl --status              # coverage report, no requests
 *   pnpm crawl --shards 3            # process up to 3 shards
 *   pnpm crawl --shards 5 --requests 30
 *
 * Bounded on purpose: at ~10 search requests a minute the full space is days of work, so
 * every run is a slice and the ledger is what makes the slices add up.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(`--${flag}`);
  return index >= 0 ? Number(args[index + 1]) : undefined;
};

async function status() {
  const { shards, repos } = await crawlCoverage();
  console.info("\nCrawl coverage");
  if (shards.length === 0) {
    console.info("  no shards yet — run without --status to seed them\n");
    return;
  }
  console.info(`  ${"status".padEnd(12)} ${"shards".padStart(7)} ${"reported".padStart(10)} ${"seen".padStart(8)}`);
  for (const row of shards) {
    console.info(
      `  ${row.status.padEnd(12)} ${String(row.shards).padStart(7)} ${String(row.reported).padStart(10)} ${String(row.seen).padStart(8)}`,
    );
  }
  console.info(
    `\n  repos: ${repos.total} found · ${repos.forks} forks skipped · ` +
      `${repos.candidates} candidates · ${repos.promoted} promoted\n`,
  );
}

if (args.includes("--status")) {
  await status();
  process.exit(0);
}

const seeded = await ensureSeedShards();
if (seeded > 0) console.info(`seeded ${seeded} shard(s)`);

const report = await runCrawl({
  maxShards: value("shards") ?? 3,
  maxRequests: value("requests") ?? 20,
  onProgress: (message) => console.info(message),
});

console.info("\nRun summary");
for (const [key, val] of Object.entries(report)) {
  console.info(`  ${key.padEnd(22)} ${val}`);
}
await status();
