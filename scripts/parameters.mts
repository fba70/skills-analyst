import "dotenv/config";

import { DECISION_PARAMETERS, RULE_SHAPE_META, vocabularyReady } from "../src/lib/decision-surface";

/**
 * The decision surface: what corpus skills branch on (Doc 7 RD.5, plan step P7).
 *
 *   pnpm parameters --probe 200     what a decision rule actually is — free, reads bundles, writes nothing
 *   pnpm parameters --sample 200    extract — COSTS MONEY (~$0.06 for 200), resumable
 *   pnpm parameters --clusters      propose the vocabulary a person curates — COSTS A FRACTION OF A CENT
 *   pnpm parameters --status        coverage first, then the finding — free
 *
 * Never scheduled. Two of the four spend, and a job that spends is a job nobody can leave
 * switched on.
 */

const args = process.argv.slice(2);
const numberAfter = (flag: string, fallback: number) => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

if (args.includes("--probe")) {
  const sample = numberAfter("--probe", 200);
  const { probeDecisionRules } = await import("../src/server/analytics/parameters-run");
  const report = await probeDecisionRules(sample);

  console.info(
    `\nWhat a decision-rule block is  (${report.versionsRead} of ${report.versionsExamined} skills read, ${report.blocks} blocks)`,
  );
  if (report.blocks === 0) {
    console.info("\n  Nothing read. Is the corpus extracted? pnpm structures --extract 500 --drain\n");
    process.exit(0);
  }

  const shapes = Object.entries(report.shapes).sort((a, b) => b[1] - a[1]);
  for (const [shape, n] of shapes) {
    const share = Math.round((n / report.blocks) * 100);
    console.info(`  ${shape.padEnd(12)} ${String(n).padStart(6)}  ${String(share).padStart(3)}%`);
  }

  /*
   * The number that decides whether the metered half is worth running, stated as a share rather
   * than left to be worked out from four rows. A parameter can only be read out of a table or a
   * conditional; the other two shapes are passages the detector typed on a word.
   */
  const usable = report.shapes.table + report.shapes.conditional;
  const usableShare = Math.round((usable / report.blocks) * 100);
  console.info(
    `\n  ${usableShare}% of these blocks are a table or a conditional — the only two shapes a` +
      `\n  parameter can be read out of. The rest contain a conditional word and branch on nothing,` +
      `\n  and the extraction's own prompt has to treat "no parameters" as an ordinary answer.`,
  );
  if (usableShare < 40) {
    console.info(
      `\n  ⚠ Below 40%. Read that as the block detector being loose rather than as a fact about` +
        `\n    the corpus — E2 found the same thing about guardrails, where the plumbing was right` +
        `\n    and the raw material was coarser than the design assumed.`,
    );
  }

  console.info("\nRead these before spending anything");
  for (const [shape, blurb] of Object.entries(RULE_SHAPE_META)) {
    console.info(`\n  ${shape.toUpperCase()} — ${blurb}`);
    for (const sample of report.samples.filter((s) => s.shape === shape)) {
      console.info(`    ${sample.slug}  ·  ${sample.words}w`);
      console.info(`      ${sample.text}`);
    }
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--sample")) {
  const limit = numberAfter("--sample", 200);
  const { runParameterExtraction } = await import("../src/server/analytics/parameters-run");
  const report = await runParameterExtraction(limit);

  console.info(`\nDecision surface extraction  (${report.examined} examined)`);
  console.info(`  stored               ${report.stored}`);
  console.info(`  named a parameter    ${report.withParameters}`);
  /*
   * Skips are printed apart from the stored counts and never summed into them. "We could not read
   * this" and "this branches on nothing" are opposite facts, and one table would let the first
   * quietly reassure somebody about the second.
   */
  console.info(`  unreadable           ${report.skipped.unreadable}`);
  console.info(`  no blocks to read    ${report.skipped["no-blocks"]}`);
  console.info(`  cost                 ${usd(report.costMicros)}`);
  if (report.stopped) {
    console.info(
      `\n  Stopped early: the platform budget refused. Everything above was stored and a re-run` +
        `\n  picks up where this left off.`,
    );
  }
  console.info(`\n  pnpm parameters --status\n`);
  process.exit(0);
}

if (args.includes("--clusters")) {
  const { clusterProposals } = await import("../src/server/analytics/parameters-run");
  const report = await clusterProposals({ minSources: numberAfter("--min-sources", 2) });

  if (report.namesConsidered === 0) {
    console.info(
      `\nNothing to cluster yet. Extract first: pnpm parameters --sample 200 — COSTS MONEY\n`,
    );
    process.exit(0);
  }

  console.info(
    `\nProposed parameter clusters  (${report.clusters.length} groups over ${report.namesConsidered} names)`,
  );
  console.info(`  ordered by distinct repositories, never by occurrences — one generator's`);
  console.info(`  eight hundred skills are one data point about the corpus\n`);
  for (const cluster of report.clusters) {
    console.info(
      `  ${cluster.proposedLabel.padEnd(28)} ${String(cluster.sources).padStart(4)} sources  ${String(cluster.count).padStart(5)} uses`,
    );
    if (cluster.members.length > 1) {
      console.info(
        `    ${cluster.members
          .slice(1, 8)
          .map((m) => `${m.name} (${m.sources})`)
          .join(" · ")}`,
      );
    }
  }
  if (report.nearestUnmerged.length > 0) {
    /*
     * Where the threshold actually sits, rather than where it was guessed. A list of pairs that
     * nearly merged is the cheapest calibration there is — the same question `scope --calibrate`
     * had to answer with two populations, answered here with the vectors already in hand.
     */
    const { CLUSTER_SIMILARITY } = await import("../src/lib/decision-surface");
    console.info(`\n  Closest pairs the ${CLUSTER_SIMILARITY} threshold kept apart`);
    for (const pair of report.nearestUnmerged) {
      console.info(`    ${pair.similarity.toFixed(3)}  ${pair.a}  /  ${pair.b}`);
    }
    const top = report.nearestUnmerged[0]?.similarity ?? 0;
    if (report.clusters.length === report.namesConsidered) {
      console.info(
        `\n  Nothing merged at all. Read the list above before changing the number: a top pair at` +
          `\n  ${top.toFixed(3)} means the threshold is slightly high, and one far below it means the` +
          `\n  composition is wrong — two short names with different value lists embed apart.`,
      );
    }
  }

  console.info(
    `\n  These are proposals, not a vocabulary. Read them, then write the ones that are real` +
      `\n  into DECISION_PARAMETERS in src/lib/decision-surface.ts — a cluster is evidence that` +
      `\n  two words co-occur, and deciding they mean one thing is a judgement with a name on it.\n`,
  );
  process.exit(0);
}

const { parameterSummary } = await import("../src/server/analytics/parameters-run");

/*
 * The table may not be there yet, and a stack trace is a worse answer than the command that
 * fixes it. `--sample` is deliberately not guarded this way: writing into a table that does not
 * exist should fail loudly, because that is a migration somebody skipped rather than a state the
 * corpus can be in.
 */
const summary = await parameterSummary().catch((error: unknown) => {
  if ((error as { cause?: { code?: string } }).cause?.code === "42P01") {
    console.info(
      "\nskill_parameters does not exist yet — generate the migration, read the SQL, apply it.\n",
    );
    process.exit(0);
  }
  throw error;
});

console.info(`\nDecision surface  (analyser ${summary.analyserVersion})`);
console.info(`  skills carrying a decision rule   ${summary.eligible}`);
console.info(`  examined at this analyser          ${summary.examined}`);
if (summary.rowsAllVersions > summary.examined) {
  console.info(
    `  rows at any analyser               ${summary.rowsAllVersions}   <- ${summary.rowsAllVersions - summary.examined} stale, re-read by the selector`,
  );
}

if (summary.examined === 0) {
  console.info(
    `\n  Nothing extracted yet.` +
      `\n    pnpm parameters --probe 200    free — read what these blocks actually are first` +
      `\n    pnpm parameters --sample 200   COSTS MONEY, about six cents\n`,
  );
  process.exit(0);
}

const share = Math.round((summary.examined / Math.max(1, summary.eligible)) * 100);
const perSkill = summary.examined > 0 ? summary.tokensChargedMicros / summary.examined : 0;
const remaining = Math.max(0, summary.eligible - summary.examined);

console.info(`  coverage                           ${share}%`);
console.info(`  named at least one parameter       ${summary.withParameters}`);
console.info(`  distinct parameter names           ${summary.distinctNames}`);
console.info(`  spent so far                       ${usd(summary.tokensChargedMicros)}`);
/*
 * Projected from what this corpus actually charged, never from a constant. The embeddings status
 * line assumed 60 tokens against a real 84 and understated the one number an operator reads
 * before deciding to run it.
 */
console.info(
  `  ${remaining} left ≈ ${usd(remaining * perSkill)} at ${usd(perSkill)} each, measured over the ${summary.examined} already done`,
);

console.info(
  `\n  vocabulary                         ${
    vocabularyReady() ? `${DECISION_PARAMETERS.length} curated parameters` : "empty — nothing can be published"
  }`,
);
if (!vocabularyReady()) {
  console.info(
    `\n  No cluster label has been curated, so no category can report a decision surface and` +
      `\n  nothing reaches an archetype. That is the honest state rather than a missing feature:` +
      `\n  Doc 7 RD.5 says the first sample is read by a person before a label is written.` +
      `\n    pnpm parameters --clusters     the proposals to read\n`,
  );
} else {
  console.info(`\n  pnpm archetypes --parameters     does the dimension discriminate?\n`);
}
process.exit(0);
