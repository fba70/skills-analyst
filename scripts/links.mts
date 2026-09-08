import "dotenv/config";

import { LINK_STATUS_META, ROT_THRESHOLD } from "../src/lib/freshness";
import { checkLinks, linkCheckSummary, rottenLinks } from "../src/server/skills/links";

/**
 * External link rot (Doc 6 RK.2, plan step E1).
 *
 *   pnpm links --status          what is known, and how much of the corpus it covers
 *   pnpm links --check 25        check the least-recently-looked-at N documents
 *   pnpm links --rotten          the confidently dead ones
 *
 * Free — no model. It does spend somebody else's bandwidth, which is why a pass is bounded, the
 * same URL is fetched once however many skills carry it, and nothing already checked is re-asked.
 */

const args = process.argv.slice(2);
const numberAfter = (flag: string, fallback: number) => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

if (args.includes("--check")) {
  const limit = numberAfter("--check", 25);
  console.info(`Checking links in ${limit} document(s), least recently checked first…\n`);
  const report = await checkLinks({ limit });
  console.info(
    `  ${report.versionsChecked} document(s) · ${report.linksChecked} link(s) · ` +
      `${report.rotten} newly rotten · ${report.recovered} recovered`,
  );
} else if (args.includes("--rotten")) {
  const rows = await rottenLinks(50);
  if (rows.length === 0) {
    console.info("Nothing confidently dead.\n");
  } else {
    console.info(`${rows.length} link(s) gone, oldest first:\n`);
    for (const row of rows) {
      console.info(
        `  ${row.slug}\n    ${row.url}\n    ${row.statusCode ?? "no response"} · ` +
          `${row.failures} consecutive · since ${row.firstFailedAt?.toISOString().slice(0, 10) ?? "?"}`,
      );
    }
  }
} else {
  const summary = await linkCheckSummary();
  const coverage =
    summary.servable > 0 ? Math.round((summary.versionsChecked / summary.servable) * 100) : 0;

  console.info("\nLink checks\n");
  console.info(`  documents checked   ${summary.versionsChecked} of ${summary.servable} (${coverage}%)`);
  console.info(`  links known         ${summary.links}`);
  console.info(`  gone                ${summary.broken}   ${LINK_STATUS_META.broken.blurb}`);
  console.info(`  blocked             ${summary.blocked}   ${LINK_STATUS_META.blocked.blurb}`);
  console.info(`  unreachable         ${summary.unreachable}   ${LINK_STATUS_META.unreachable.blurb}`);
  console.info(`  oldest check        ${summary.oldest?.toISOString().slice(0, 10) ?? "never"}`);
  /*
   * Coverage before conclusions. A corpus 3% checked reporting "4 dead links" invites the reader
   * to conclude the corpus is healthy, which is the `archetypes --blocks` mistake in a new place.
   */
  if (coverage < 50) {
    console.info(
      `\n  Only ${coverage}% of servable skills have been checked, so the counts above are a\n` +
        `  statement about that slice rather than about the corpus. Run: pnpm links --check 200`,
    );
  }
  console.info(`\n  A link is reported gone after ${ROT_THRESHOLD} consecutive 404s or 410s.\n`);
}

process.exit(0);
