import "dotenv/config";

import { DRIFT_STEPS_BEFORE_SURFACING, VERSIONED } from "../src/lib/versions";

/**
 * Version drift — what the corpus pins, and what has shipped since (Doc 7 RD.10, step P5).
 *
 *   pnpm versions --check          # read every tracked project's latest release, and store it
 *   pnpm versions --check --dry    # the same, printed, storing nothing
 *   pnpm versions --status         # what is stored, and how stale the check itself is
 *
 * Free. Twenty requests a pass, bounded and deadlined, and **not scheduled** — a job nobody
 * watches is one nobody notices failing, which is the standing rule rather than a cost worry.
 */

const args = process.argv.slice(2);

if (args.includes("--check")) {
  const dry = args.includes("--dry");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

  const { checkVersions } = await import("../src/server/skills/versions");
  const report = await checkVersions({ dry, only });

  console.info(
    `\nLatest release per tracked project  (${report.checked} checked${dry ? ", nothing stored" : ""})`,
  );
  for (const outcome of report.outcomes) {
    console.info(
      `  ${outcome.subject.padEnd(14)} ${outcome.status.padEnd(12)} ` +
        `${(outcome.version ?? "—").padEnd(16)} ` +
        `${outcome.releasedAt ? outcome.releasedAt.toISOString().slice(0, 10) : ""}` +
        `${outcome.statusCode && outcome.status !== "ok" ? `  (${outcome.statusCode})` : ""}`,
    );
  }
  console.info(`\n  ok ${report.ok} · blocked ${report.blocked} · unreachable ${report.unreachable}`);
  if (report.blocked > 0) {
    /*
     * Said plainly, because a rate limit reads as a broken feed otherwise. `blocked` is a fact
     * about our request, not about the project — the distinction `checkLink` draws, and the
     * reason a failure never clears a version already known.
     */
    console.info(
      "  blocked is usually GitHub's unauthenticated rate limit (60/hour). Set GITHUB_TOKEN and re-run.",
    );
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--status")) {
  const { versionSummary } = await import("../src/server/skills/versions");
  const summary = await versionSummary();

  console.info(`\nVersion drift  (${summary.tracked} projects tracked)`);
  console.info(
    `  documents pinning a version   ${summary.documentsWithPins}` +
      `  — of any name; the vocabulary filters on read`,
  );
  if (summary.checked === 0) {
    console.info("\n  nothing checked yet — pnpm versions --check\n");
    process.exit(0);
  }

  console.info("\n  project        current          released     checked      state");
  for (const row of summary.rows) {
    const age = Math.round((Date.now() - row.checkedAt.getTime()) / 86_400_000);
    console.info(
      `  ${row.subject.padEnd(14)} ${(row.currentVersion ?? "—").padEnd(16)} ` +
        `${(row.releasedAt ? row.releasedAt.toISOString().slice(0, 10) : "—").padEnd(12)} ` +
        `${`${age}d ago`.padEnd(12)} ${row.status}` +
        `${row.consecutiveFailures > 0 ? `  (${row.consecutiveFailures} failed in a row)` : ""}`,
    );
  }

  const untracked = VERSIONED.filter((v) => !summary.rows.some((r) => r.subject === v.id));
  if (untracked.length > 0) {
    console.info(`\n  never checked: ${untracked.map((v) => v.id).join(", ")}`);
  }
  console.info(
    `\n  A skill is only shown as drifting at ${DRIFT_STEPS_BEFORE_SURFACING}+ releases behind, counted in` +
      `\n  the unit the project moves in — majors for Node, minors for Python, Go and Terraform.` +
      `\n  Drift is never rot: a skill teaching one version's idioms is right for a codebase on it.\n`,
  );
  process.exit(0);
}

console.info(
  "usage: pnpm versions --check [--dry] [--only <id>]\n       pnpm versions --status",
);
process.exit(1);
