import "dotenv/config";

import { validatePending } from "../src/server/validation/run";

/**
 * Runs the rules-only validation pass.
 *
 *   pnpm validate                # everything still awaiting a verdict
 *   pnpm validate --revalidate   # re-judge everything (a re-scan campaign)
 *   pnpm validate --limit 5
 */

const args = process.argv.slice(2);
const limitRaw = args[args.indexOf("--limit") + 1];

const outcomes = await validatePending({
  revalidate: args.includes("--revalidate"),
  limit: args.includes("--limit") ? Number(limitRaw) : undefined,
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
