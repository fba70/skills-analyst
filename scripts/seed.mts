import "dotenv/config";

import { applySeedLists, applySeedRepos, expandList } from "../src/server/crawl/seed-run";
import { sourceDiversity } from "../src/server/analytics/templates";
import { SEED_LISTS, SEED_REJECTED, SEED_REPOS } from "../src/server/crawl/seeds";
import { discoveryPolicy } from "../src/server/crawl/policy";

/**
 * Seed the corpus from curated sources (Doc 4 §4 steps 1–2).
 *
 *   pnpm seed --status                 # the seed set, and how balanced the corpus is
 *   pnpm seed --repos                  # apply the seed allow-list (promotes directly)
 *   pnpm seed --repos --only anthropics/skills,garrytan/gstack
 *   pnpm seed --lists                  # expand every curated list into candidates
 *   pnpm seed --list owner/name        # expand one list
 *
 * Neither path skips anything. Seeds and lists change *what is found and in what order*;
 * every candidate still goes through enrich → decide → sync → validate. Run
 * `pnpm promote` after `--lists` to work through the candidates they produce.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(`--${flag}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const submittedBy = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "cli.seed";

/**
 * Structural diversity, not share of corpus.
 *
 * Share was the wrong instrument: it flags a large varied source and misses a small cloned
 * one. `pnpm structures --templates` has the full breakdown; this is the summary.
 */
async function balance() {
  const rows = await sourceDiversity(12);
  if (rows.length === 0) return;

  const floor = discoveryPolicy.minStructuralDiversityPercent;
  console.info("\nStructural diversity by source  (skills / distinct shapes)");
  for (const row of rows) {
    const flag = row.diversity < floor ? "  ← monoculture" : "";
    const bar = "█".repeat(Math.max(1, Math.round(row.diversity / 4)));
    console.info(
      `  ${String(row.skills).padStart(5)} / ${String(row.structures).padStart(4)}  ` +
        `${String(row.diversity).padStart(3)}%  ${bar}${flag}`,
    );
    console.info(`         ${row.source}`);
  }
}

if (args.includes("--status")) {
  console.info(`\nSeed allow-list — ${SEED_REPOS.length} origin repo(s)`);
  for (const seed of SEED_REPOS) {
    console.info(
      `  ${seed.repo.padEnd(34)} ~${String(seed.markersAtVerification).padStart(4)} markers   ${seed.note}`,
    );
  }

  console.info(`\nCurated lists — ${SEED_LISTS.length}`);
  for (const list of SEED_LISTS) {
    console.info(`  ${list.repo.padEnd(34)} ${list.note}`);
  }

  console.info("\nConsidered and rejected");
  for (const row of SEED_REJECTED) {
    console.info(`  ${row.repo.padEnd(34)} ${row.reason}`);
  }

  await balance();
  console.info("");
  process.exit(0);
}

if (args.includes("--repos")) {
  const only = value("only")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const report = await applySeedRepos({
    submittedBy,
    only,
    onProgress: (m) => console.info(`  ${m}`),
  });

  console.info("\nSeed repositories");
  for (const row of report.results) {
    console.info(`  ${row.ok ? "✓" : "✗"} ${row.repo.padEnd(34)} ${row.detail}`);
  }
  console.info(
    `\n${report.added} added, ${report.alreadyKnown} already known, ${report.failed} failed · ` +
      `${report.skillsFound} skill(s) reachable\n` +
      `  Next: pnpm sync   (fetch them), then pnpm validate`,
  );
}

if (args.includes("--list") || args.includes("--lists")) {
  const single = value("list");
  const reports = single
    ? [
        await expandList(
          { owner: single.split("/")[0], repo: single.split("/")[1] },
          { submittedBy },
        ),
      ]
    : await applySeedLists({ submittedBy, onProgress: (m) => console.info(`  ${m}`) });

  console.info("\nCurated lists");
  for (const row of reports) {
    const failure = (row as ListReportWithError).error;
    if (failure) {
      console.info(`  ✗ ${row.list.padEnd(34)} ${failure}`);
      continue;
    }
    console.info(
      `  ✓ ${row.list.padEnd(34)} ${row.candidates} candidate(s) from ${row.linksSeen} link(s) · ` +
        `${row.inserted} new, ${row.alreadyKnown} known`,
    );
    if (row.filesRead.length > 0) {
      console.info(`      read ${row.filesRead.join(", ")}`);
    }
  }
  console.info("\n  Next: pnpm promote   (enrich and decide on the new candidates)");
}

type ListReportWithError = { error?: string };

await balance();
console.info("");
process.exit(0);
