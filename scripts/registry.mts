import "dotenv/config";

import { importSkillsSh, readSkillsShIndex } from "../src/server/crawl/registries";

/**
 * Registry reconciliation (Doc 4 §4 channel 4, R1.1(d)).
 *
 *   pnpm registry --status              what skills.sh lists, and how much of it is new
 *   pnpm registry --import [--min 5]    file the listings as discovery candidates
 *
 * Free: no model call, and four sitemap fetches rather than a page per skill. Candidates
 * land at `status: "new"` for `pnpm promote --enrich --decide` to judge — a registry
 * listing is a popularity signal, and popularity is not quality.
 */
const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (flag: string) => {
  const v = Number(value(flag));
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

if (args.includes("--import")) {
  const report = await importSkillsSh({ minSkills: num("min") ?? 1, limit: num("limit") });
  console.info(
    `\n${report.registry} — ${report.urlsSeen.toLocaleString()} URLs, ` +
      `${report.reposFound.toLocaleString()} repos listed\n` +
      `  new candidates   ${report.inserted}\n` +
      `  already known    ${report.alreadyKnown}\n\n` +
      `Next: pnpm promote --enrich --decide\n`,
  );
} else {
  const { urlsSeen, repos } = await readSkillsShIndex();
  console.info(
    `\nskills.sh (via sitemap)\n  skill URLs   ${urlsSeen.toLocaleString()}\n` +
      `  repositories ${repos.length.toLocaleString()}\n`,
  );
  console.info("Largest listings:");
  for (const r of repos.slice(0, 15)) {
    console.info(`  ${String(r.skillCount).padStart(4)}  ${r.owner}/${r.repo}`);
  }
  console.info("\n  --import to file these as discovery candidates.\n");
}

process.exit(0);
