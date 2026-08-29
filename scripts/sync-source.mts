import "dotenv/config";

import { syncSource } from "../src/server/ingest/sync";

/**
 * Runs one sync pass from the command line.
 *
 * Phase 1 has no scheduler: syncs are hand-run, which is why this exists. When we deploy,
 * a cron dispatcher calls the same `syncSource` — this script is not a parallel
 * implementation, just a different trigger.
 *
 *   pnpm sync https://github.com/anthropics/skills --include skills/ --dry-run
 *   pnpm sync https://github.com/anthropics/skills --include skills/ --limit 5
 */

const args = process.argv.slice(2);
const url = args.find((arg) => !arg.startsWith("--"));

if (!url) {
  console.error(
    [
      "usage: pnpm sync <github-repo-url> [options]",
      "",
      "  --include <prefix>   only look under this path (repeatable)",
      "  --ref <ref>          branch, tag or commit (default: the repo's default branch)",
      "  --limit <n>          stop after n skills",
      "  --dry-run            walk and report, write nothing",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function flagValues(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

const includePaths = flagValues("include");
const ref = flagValues("ref")[0];
const limitRaw = flagValues("limit")[0];
const dryRun = args.includes("--dry-run");

const report = await syncSource({
  sourceUrl: url,
  includePaths: includePaths.length > 0 ? includePaths : undefined,
  ref,
  limit: limitRaw ? Number(limitRaw) : undefined,
  dryRun,
  onProgress: (message) => console.info(message),
});

const width = Math.max(20, ...report.skills.map((s) => (s.path || ".").length));
console.info(`\n${dryRun ? "DRY RUN — nothing written" : "Sync complete"}`);
console.info(`source   ${report.sourceUrl}`);
console.info(`commit   ${report.commitSha ?? "-"}`);
console.info(`signals  ${JSON.stringify(report.signals)}`);
console.info("");
console.info(
  `${"skill".padEnd(width)}  ${"licence".padEnd(14)}  ${"posture".padEnd(21)}  ${"resolved by".padEnd(17)}  mirror  files`,
);
console.info("-".repeat(width + 74));

for (const skill of report.skills) {
  console.info(
    [
      (skill.path || ".").padEnd(width),
      (skill.licenseSpdx ?? "—").padEnd(14),
      skill.redistribution.padEnd(21),
      skill.licenseSource.padEnd(17),
      (skill.contentStored ? "yes" : "no").padEnd(6),
      String(skill.fileCount),
    ].join("  "),
  );
  if (skill.parseError) {
    console.info(`${" ".repeat(width)}  ! ${skill.parseError}`);
  }
}

const mirrored = report.skills.filter((s) => s.contentStored).length;
console.info("");
console.info(
  `${report.skills.length} skill(s): ${mirrored} mirrored, ${report.skills.length - mirrored} metadata-only` +
    (dryRun ? "" : ` · ${report.created} created, ${report.unchanged} unchanged`),
);
console.info("");
