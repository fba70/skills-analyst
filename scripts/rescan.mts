import "dotenv/config";

import { runRescan, staleSlices } from "../src/server/validation/rescan";

/**
 * Re-scan campaigns (Doc 2 R2.12).
 *
 *   pnpm rescan --status                       # what is out of date, per analyzer
 *   pnpm rescan --run 200                      # re-judge a bounded slice
 *   pnpm rescan --run 200 --analyzer structural-lint
 *   pnpm rescan --all                          # loop until nothing is stale
 *
 * Rules only — the LLM analyzers are never re-run by a campaign, so this costs nothing.
 */

const args = process.argv.slice(2);
const num = (flag: string, fallback?: number) => {
  const i = args.indexOf(`--${flag}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function status() {
  const slices = await staleSlices();
  console.info("\nVerdict freshness");
  for (const slice of slices) {
    const flag = slice.total > 0 ? " ←" : "";
    console.info(
      `  ${slice.analyzer.padEnd(26)} current ${slice.currentVersion}   ${String(slice.total).padStart(5)} stale${flag}`,
    );
    for (const row of slice.behind) {
      console.info(`      ${row.version.padEnd(10)} ${String(row.count).padStart(5)}`);
    }
  }
  const total = slices.reduce((sum, s) => sum + s.total, 0);
  console.info(
    total === 0
      ? "\nEvery verdict is at the current analyzer version.\n"
      : `\n${total} version(s) carry verdicts from a superseded analyzer.\n`,
  );
  return total;
}

if (args.includes("--status")) {
  await status();
  process.exit(0);
}

if (args.includes("--run") || args.includes("--all")) {
  const limit = num("run", 200) ?? 200;
  const analyzer = value("analyzer");
  const passes = args.includes("--all") ? 200 : 1;

  for (let pass = 1; pass <= passes; pass += 1) {
    const report = await runRescan({ analyzer, limit, onProgress: (m) => console.info(m) });
    if (report.selected === 0) {
      console.info("nothing stale");
      break;
    }
    console.info(
      `  re-judged ${report.rejudged} · ${report.statusChanged} changed status · ` +
        `${report.scoreChanged} changed score · ${report.remaining} still stale`,
    );
    if (report.remaining === 0) break;
  }
}

await status();
process.exit(0);
