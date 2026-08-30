import "dotenv/config";

import { validatePending, versionsWithCode } from "../src/server/validation/run";

/**
 * Runs the rules-only validation pass.
 *
 *   pnpm validate                     # everything still awaiting a verdict
 *   pnpm validate --revalidate        # re-judge everything (a re-scan campaign)
 *   pnpm validate --limit 5
 *   pnpm validate --consistency --limit 10   # ALSO run R2.3 — costs money per skill
 *
 * `--consistency` targets only skills whose bundle actually contains code, because a skill
 * with no code cannot misrepresent its code. On this corpus that is ~7% of it.
 *
 * `--consistency` adds the LLM description-vs-code audit. It is off by default and refuses
 * to run unbounded: the whole point of the rules-only pass is that you can trigger it
 * without thinking about the bill, and that stops being true the moment an expensive
 * analyzer is in the default set.
 */

const args = process.argv.slice(2);
const limitRaw = args[args.indexOf("--limit") + 1];
const limit = args.includes("--limit") ? Number(limitRaw) : undefined;
const consistency = args.includes("--consistency");

/** Ceiling on one costly run. A fuse, matching the taxonomy classifier's. */
const MAX_COSTLY = 100;

if (consistency && (!limit || limit > MAX_COSTLY)) {
  console.error(
    `\n--consistency calls a model for every skill that bundles code.\n` +
      `Pass an explicit --limit of ${MAX_COSTLY} or fewer.\n`,
  );
  process.exit(1);
}

if (consistency) {
  console.info(`\nRunning R2.3 description-consistency on up to ${limit} version(s) — this costs money.`);
}

// A consistency run targets the bundles that have code; everything else would be a paid
// call with a foregone answer.
const versionIds = consistency ? await versionsWithCode(limit) : undefined;

if (consistency && versionIds && versionIds.length === 0) {
  console.info("\nNo un-audited skills with bundled code. Nothing to do.\n");
  process.exit(0);
}

const outcomes = await validatePending({
  revalidate: args.includes("--revalidate") || consistency,
  includeCostly: consistency,
  versionIds,
  limit,
  onProgress: () => {},
});

const width = Math.max(12, ...outcomes.map((o) => o.slug.length));
console.info(
  `\n${"skill".padEnd(width)}  ${"status".padEnd(12)}  score  source    reasons`,
);
console.info("-".repeat(width + 52));

for (const outcome of outcomes.sort((a, b) => a.slug.localeCompare(b.slug))) {
  console.info(
    [
      outcome.slug.padEnd(width),
      outcome.status.padEnd(12),
      String(outcome.qualityScore).padStart(5),
      outcome.origin.padEnd(8),
      outcome.reasons.join(", ") || "—",
    ].join("  "),
  );
}

const indexed = outcomes.filter((o) => o.status === "indexed").length;
const quarantined = outcomes.length - indexed;
console.info(
  `\n${outcomes.length} validated: ${indexed} indexed, ${quarantined} quarantined\n`,
);
