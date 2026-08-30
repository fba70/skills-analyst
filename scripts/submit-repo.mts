import "dotenv/config";

import { submitRepository } from "../src/server/crawl/submit";

/**
 * Submit a repository by hand (Doc 2 R1.8).
 *
 *   pnpm submit https://github.com/anthropics/skills
 *   pnpm submit anthropics/skills
 *   pnpm submit owner/monorepo --include workspaces/,packages/
 *   pnpm submit owner/repo --review     # queue it instead of promoting
 *
 * The repository is checked before it is accepted — it must exist and actually contain
 * skill markers. Accepted repositories then ride the normal pipeline: `pnpm sync` fetches
 * them, `pnpm validate` judges them. Nothing here skips validation.
 */

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));

if (!target) {
  console.error(
    "\nUsage: pnpm submit <repo-url|owner/name> [--include prefix1,prefix2] [--review]\n",
  );
  process.exit(1);
}

const includeIndex = args.indexOf("--include");
const includePaths =
  includeIndex >= 0
    ? (args[includeIndex + 1] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : undefined;

const outcome = await submitRepository(target, {
  submittedBy: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "cli",
  autoPromote: !args.includes("--review"),
  includePaths,
});

if (!outcome.ok) {
  console.error(`\n✗ ${outcome.reason}\n`);
  process.exit(1);
}

console.info(`\n✓ ${outcome.owner}/${outcome.repo} — ${outcome.status}`);
console.info(`  skills found   ${outcome.skillsFound}`);
console.info(`  stars          ${outcome.stars ?? "—"}`);
console.info(`  licence        ${outcome.licenseSpdx ?? "unresolved"}`);
if (outcome.alreadyKnown) {
  console.info(`  note           already known as a ${outcome.alreadyKnown} — updated, not duplicated`);
}
console.info("\n  sample paths");
for (const path of outcome.samplePaths) console.info(`    ${path}`);
console.info(
  outcome.status === "promoted"
    ? "\n  Next: pnpm sync   (fetch it), then pnpm validate\n"
    : "\n  Next: approve it in /settings → Review\n",
);
process.exit(0);
