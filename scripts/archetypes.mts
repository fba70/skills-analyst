import "dotenv/config";

import { mineArchetype } from "../src/server/analytics/archetype";
import { archetypeSummary, mineAll, mineAndStore } from "../src/server/analytics/archetype-run";
import { labelFor } from "../src/server/taxonomy/vocabulary";

/**
 * Archetype mining (Doc 2 R3.2).
 *
 *   pnpm archetypes --status              # what has been mined
 *   pnpm archetypes --show review         # inspect one without storing it
 *   pnpm archetypes --mine review         # mine and store one
 *   pnpm archetypes --mine-all            # every category that clears the gate
 *
 * Free: derived entirely from stored fingerprints and labels. No model is involved.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function render(a: NonNullable<Awaited<ReturnType<typeof mineArchetype>>>) {
  console.info(
    `\n${labelFor("function", a.category)}  —  ${a.skillCount} skills → ${a.distinctStructures} structures from ${a.sourceCount} sources`,
  );
  console.info(
    `gate ${a.meetsGate ? "PASS" : `FAIL (${a.gateReason})`} · curated vs other sources · avg quality ${a.strongThreshold} vs ${a.weakThreshold}`,
  );

  if (a.skeleton.sections.length > 0) {
    console.info("\n  SECTIONS                     curated / other   lift");
    for (const s of a.skeleton.sections) {
      console.info(
        `  ${s.required ? "▪" : "·"} ${s.role.padEnd(26)} ${String(s.strongPrevalence).padStart(3)}% / ${String(s.weakPrevalence).padStart(3)}%   +${s.lift}`,
      );
    }
  }

  /*
   * Blocks under the sections, in the order the strong band writes them.
   *
   * Density is printed beside the prevalence because the two say different things and one
   * of them is not a reason anything is on this list: inclusion is decided on presence, by
   * the same rule the sections use, and the count is descriptive evidence.
   */
  if (a.skeleton.blocks.length > 0) {
    console.info("\n  BLOCKS                       curated / other   lift   per skill   position");
    for (const b of a.skeleton.blocks) {
      console.info(
        `  ${b.required ? "▪" : "·"} ${b.type.padEnd(26)} ${String(b.strongPrevalence).padStart(3)}% / ${String(b.weakPrevalence).padStart(3)}%   +${String(b.lift).padEnd(4)}  ` +
          `${b.strongDensity.toFixed(1)} / ${b.weakDensity.toFixed(1)}    ${b.typicalPosition.toFixed(2)}`,
      );
    }
    /* The rejects, one line, because a type that missed by two points is a different fact
       from one that was never considered — and the negatives are the evidence behind the
       decision not to publish block anti-patterns. */
    const rejected = a.measuredBlocks.filter((b) => !b.kept);
    if (rejected.length > 0) {
      console.info(
        `    rejected: ${rejected
          .sort((x, y) => y.lift - x.lift)
          .map((b) => `${b.type} ${b.lift >= 0 ? "+" : "−"}${Math.abs(b.lift)}`)
          .join(", ")}`,
      );
    }
  }

  if (a.skeleton.traits.length > 0) {
    console.info("\n  DO");
    for (const t of a.skeleton.traits) {
      console.info(
        `    ${t.label.padEnd(38)} ${String(t.strongPrevalence).padStart(3)}% / ${String(t.weakPrevalence).padStart(3)}%   +${t.lift}`,
      );
    }
  }

  if (a.antiPatterns.length > 0) {
    console.info("\n  AVOID");
    for (const t of a.antiPatterns) {
      console.info(
        `    ${t.label.padEnd(38)} ${String(t.strongPrevalence).padStart(3)}% / ${String(t.weakPrevalence).padStart(3)}%   ${t.lift}`,
      );
    }
  }

  console.info(
    `\n  NORMS  ~${a.skeleton.norms.medianWords} words · description ~${a.skeleton.norms.medianDescriptionLength} chars · ${a.skeleton.norms.medianFileCount} file(s)`,
  );
  console.info(`  EXEMPLARS  ${a.exemplars.map((e) => e.slug).join(", ") || "(none licence-clean)"}`);
}

if (args.includes("--parameters")) {
  /**
   * Does the decision surface discriminate? (Doc 7 RD.5, plan step P7.)
   *
   *   pnpm archetypes --parameters
   *   pnpm archetypes --parameters --category review
   *
   * Free, and it **writes nothing**. Two gates stand between this table and an archetype card,
   * and the command says which one is shut: a curated vocabulary, and the extraction coverage
   * behind it.
   */
  const { parameterLiftAcrossCategories, mineParameterLift } = await import(
    "../src/server/analytics/parameters-mine"
  );
  const { FUNCTIONS } = await import("../src/server/taxonomy/vocabulary");
  const { MIN_BAND } = await import("../src/server/analytics/archetype");
  const { DECISION_PARAMETERS } = await import("../src/lib/decision-surface");

  const categoryIndex = args.indexOf("--category");
  const one = categoryIndex >= 0 ? args[categoryIndex + 1] : undefined;

  if (one) {
    const result = await mineParameterLift(one);
    if (!result) {
      console.info(`\nno representatives for ${one}\n`);
      process.exit(0);
    }
    console.info(
      `\nParameters measured in ${one}  (${result.strongBand} curated / ${result.weakBand} other` +
        ` · ${result.examined} of ${result.structures} examined · ${result.recognised} named a curated parameter)`,
    );
    if (!result.banded) {
      console.info(`  a band is below ${MIN_BAND}; a percentage over it would not mean anything\n`);
      process.exit(0);
    }
    if (result.measured.length === 0) {
      console.info(
        `  nothing measured — ` +
          (DECISION_PARAMETERS.length === 0
            ? "the vocabulary is empty, so no extracted name resolves to anything\n"
            : "no examined skill in this category branches on a curated parameter\n"),
      );
      process.exit(0);
    }
    console.info("\n  parameter              strong / weak   lift  needed   kept");
    for (const row of result.measured) {
      console.info(
        `  ${row.label.padEnd(22)} ${String(row.strongPrevalence).padStart(4)}% / ${String(row.weakPrevalence).padStart(4)}%  ` +
          `${String(row.lift).padStart(5)}  ${row.requiredLift.toFixed(1).padStart(6)}   ${row.kept ? "yes" : "no"}` +
          (row.kept ? "" : `   (${row.rejectedFor})`),
      );
    }
    console.info("");
    process.exit(0);
  }

  /*
   * Coverage first, and the finding withheld under it — `archetypes --blocks`'s refusal, which
   * exists because a table of zeros at 1% extraction reads as *this dimension carries no signal*
   * when the truth is *nothing has been measured yet*. Same output, opposite conclusions, on the
   * command whose job is to decide whether the rest of the step gets built.
   *
   * The vocabulary is asked **before** any query runs. It needs no database, it is the gate that
   * is actually shut today, and a crash about a missing table would hide the answer behind a
   * stack trace about the plumbing.
   */
  if (DECISION_PARAMETERS.length === 0) {
    const { parameterSummary } = await import("../src/server/analytics/parameters-run");
    const summary = await parameterSummary().catch(() => null);
    const extracted = summary?.examined ?? 0;
    const eligible = summary?.eligible ?? 0;
    const share = eligible === 0 ? 0 : (extracted / eligible) * 100;

    console.info(`\nDecision-surface lift: cannot be answered yet.`);
    console.info(
      `\n  extracted                     ${extracted} of ${eligible}` +
        `  (${share.toFixed(1)}%)` +
        (summary ? "" : "   <- skill_parameters does not exist yet"),
    );
    console.info(`  curated parameters            0   <- this is what is missing`);
    console.info(
      `\n  An extracted name is a word a model chose. Until somebody has read the clusters and` +
        `\n  written the real ones into DECISION_PARAMETERS, every percentage here would describe` +
        `\n  the model's habits rather than the corpus — Doc 7 RD.5 says so in as many words.` +
        `\n\n    pnpm parameters --probe 200    free, and the honest first step` +
        `\n    pnpm parameters --sample 200   COSTS MONEY` +
        `\n    pnpm parameters --clusters     the proposals to curate\n`,
    );
    process.exit(0);
  }

  const report = await parameterLiftAcrossCategories(FUNCTIONS.map((f) => f.id));
  const pct = report.coverage.eligible === 0
    ? 0
    : (report.coverage.extracted / report.coverage.eligible) * 100;

  if (report.banded.length === 0) {
    console.info(
      `\nNo category has both bands above the floor — nothing to measure.` +
        `\n  pnpm taxonomy --status   the labels the bands are built from\n`,
    );
    process.exit(0);
  }

  console.info(
    `\nDecision-surface lift across ${report.banded.length} banded categories  (writes nothing)`,
  );
  console.info(
    `  extracted ${report.coverage.extracted} of ${report.coverage.eligible} eligible skills (${pct.toFixed(1)}%)`,
  );
  if (pct < 90) {
    console.info(
      `  WARNING: at ${pct.toFixed(1)}% these prevalences will move. A partial extraction is not a` +
        `\n  random sample of a category — the selector has no ORDER BY.`,
    );
  }
  console.info("\n  parameter              kept in   best lift  median  where");
  for (const row of report.byParameter.slice(0, 30)) {
    console.info(
      `  ${row.label.padEnd(22)} ${String(row.keptIn).padStart(4)}/${String(report.banded.length).padEnd(3)} ` +
        `${String(row.bestLift).padStart(9)}  ${String(row.medianLift).padStart(6)}  ${row.bestCategory || "—"}`,
    );
  }
  const earning = report.byParameter.filter((p) => p.keptIn > 0);
  console.info(
    `\n  ${earning.length} of ${report.byParameter.length} parameters clear the threshold in at least one category.` +
      (earning.length === 0
        ? "\n  Nothing to publish: the decision surface does not separate the bands, and a dimension" +
          "\n  that earns nothing gets reported here rather than put on an archetype card.\n"
        : "\n  Publishing these is a deliberate act: bump MINER_VERSION and re-mine, or the new" +
          "\n  dimension reaches exactly zero archetypes and says nothing about it.\n"),
  );
  process.exit(0);
}

if (args.includes("--tools")) {
  /**
   * Does the tool axis discriminate? (Doc 7 RD.9, plan step P3.)
   *
   *   pnpm archetypes --tools
   *   pnpm archetypes --tools --category review
   *
   * Free, and it **writes nothing**. Doc 7 §2 principle 4: a mined dimension is a probe
   * before it is a finding, and a tool lift only reaches an author if this table earns it.
   * Same posture, and the same imported bands and threshold, as `--blocks`.
   */
  const { toolLiftAcrossCategories, mineToolLift } = await import(
    "../src/server/analytics/tools-mine"
  );
  const { FUNCTIONS } = await import("../src/server/taxonomy/vocabulary");
  const { MIN_BAND } = await import("../src/server/analytics/archetype");

  const categoryIndex = args.indexOf("--category");
  const one = categoryIndex >= 0 ? args[categoryIndex + 1] : undefined;

  if (one) {
    const result = await mineToolLift(one);
    if (!result) {
      console.info(`\nno representatives for ${one}\n`);
      process.exit(0);
    }
    console.info(
      `\nTools measured in ${one}  (${result.strongBand} curated / ${result.weakBand} other` +
        ` · ${result.withTools} of ${result.structures} name a recognised tool)`,
    );
    if (!result.banded) {
      console.info(`  a band is below ${MIN_BAND}; a percentage over it would not mean anything\n`);
      process.exit(0);
    }
    console.info("\n  tool                   strong / weak   lift  needed   kept");
    for (const row of result.measured) {
      console.info(
        `  ${row.label.padEnd(22)} ${String(row.strongPrevalence).padStart(4)}% / ${String(row.weakPrevalence).padStart(4)}%  ` +
          `${String(row.lift).padStart(5)}  ${row.requiredLift.toFixed(1).padStart(6)}   ${row.kept ? "yes" : "no"}` +
          (row.kept ? "" : `   (${row.rejectedFor})`),
      );
    }
    console.info("");
    process.exit(0);
  }

  const { banded, byTool } = await toolLiftAcrossCategories(FUNCTIONS.map((f) => f.id));
  if (banded.length === 0) {
    /*
     * The refusal `archetypes --blocks` had to learn: printing a table of zeros reads as
     * *the tool axis carries no signal* when the truth is *nothing has been measured*. Same
     * output, opposite conclusions, on the command whose job is to decide whether the rest
     * of the step gets built.
     */
    console.info(
      "\nNo category has both bands above the floor — nothing to measure." +
        "\n  pnpm structures --resolve-tools --drain   fills skill_tools\n",
    );
    process.exit(0);
  }

  console.info(`\nTool lift across ${banded.length} banded categories  (writes nothing)`);
  console.info("\n  tool                   kept in   best lift  median  where");
  for (const row of byTool.slice(0, 30)) {
    console.info(
      `  ${row.label.padEnd(22)} ${String(row.keptIn).padStart(4)}/${String(banded.length).padEnd(3)} ` +
        `${String(row.bestLift).padStart(9)}  ${String(row.medianLift).padStart(6)}  ${row.bestCategory ?? "—"}`,
    );
  }
  /*
   * The other number this table is asked for, and it is not a lift.
   *
   * RD.8 wants to tell an author *"92% of curated skills that name `git` carry a guardrail;
   * you have none"*. That is a conditional share within one band, not a contrast between two,
   * so it survives whatever the lift says — and on this corpus the lift says nothing, which
   * makes the distinction worth printing rather than assuming.
   */
  const { destructiveAmong } = await import("../src/lib/tools");
  const { guardrailPrevalenceFor, MIN_GUARDRAIL_EVIDENCE, MIN_GUARDRAIL_SOURCES } = await import(
    "../src/server/analytics/tools-mine"
  );
  const destructive = destructiveAmong(byTool.map((t) => t.tool));
  if (destructive.length > 0) {
    console.info(
      `\n  Of curated skills naming a destructive tool, how many carry a guardrail` +
        `  (RD.8's sentence; withheld below ${MIN_GUARDRAIL_EVIDENCE} skills from ${MIN_GUARDRAIL_SOURCES} sources)`,
    );
    for (const tool of destructive) {
      const evidence = await guardrailPrevalenceFor(tool);
      const { toolLabel } = await import("../src/lib/tools");
      console.info(
        `    ${toolLabel(tool).padEnd(22)} ` +
          (evidence
            ? `${String(evidence.share).padStart(3)}%  over ${evidence.skills} skills from ${evidence.sources} sources`
            : "—     too few curated skills, or too few repositories, to quote a share"),
      );
    }
  }

  const earning = byTool.filter((t) => t.keptIn > 0);
  console.info(
    `\n  ${earning.length} of ${byTool.length} tools clear the threshold in at least one category.` +
      (earning.length === 0
        ? "\n  Nothing to publish: the tool axis does not separate the bands, and a dimension that" +
          "\n  earns nothing gets reported here rather than put on an archetype card.\n"
        : "\n  Read these before publishing any of them — a tool lift is a fact about what curated" +
          "\n  skills reach for, never advice to write it into a draft.\n"),
  );
  process.exit(0);
}

if (args.includes("--blocks")) {
  /**
   * Does the block grain discriminate? (Doc 6 RW.2, mining v1.)
   *
   *   pnpm archetypes --blocks
   *
   * Free. Measures only — folding blocks into the published skeleton is a separate change
   * with its own miner version, because the moment a block lift reaches /build every draft
   * in the product is scaffolded from it.
   *
   * The number to read is the comparison, not the absolute: the best *section* lift across
   * the three largest categories is +10 and bundle traits reach +35. A block type that
   * clears its threshold in no category has earned nothing and Doc 6 §7 says to prune it.
   */
  const { blockLiftAcrossCategories } = await import("../src/server/analytics/blocks-mine");
  const { FUNCTIONS } = await import("../src/server/taxonomy/vocabulary");
  const { MIN_BAND } = await import("../src/server/analytics/archetype");
  const { EXTRACTOR_VERSION } = await import("../src/server/analytics/structure");
  const { byType, banded, examined, coverage } = await blockLiftAcrossCategories(
    FUNCTIONS.map((f) => f.id),
  );

  const pctCoverage =
    coverage.eligible > 0 ? (coverage.fingerprinted / coverage.eligible) * 100 : 0;

  /**
   * Refuse to answer rather than answer with zeros.
   *
   * The first version filtered to banded categories and printed the type table regardless,
   * so at 1% re-extraction it rendered eleven rows of `0/0  0  0` — which reads as "blocks
   * carry no signal" when the truth is "nothing has been measured yet". Those are the same
   * output and opposite conclusions, and this command exists to decide whether to build the
   * rest of the Doc 6 programme. Same rule as `taxonomy --compare`, which exits non-zero
   * rather than print a confident wrong answer about a $130 decision.
   */
  if (banded.length === 0) {
    console.info(`\nBlock-type lift: cannot be answered yet.`);
    console.info(
      `\n  fingerprints at ${EXTRACTOR_VERSION}   ${coverage.fingerprinted} of ${coverage.eligible}` +
        `  (${pctCoverage.toFixed(1)}%)`,
    );
    console.info(`  categories with any evidence  ${examined.length} of ${FUNCTIONS.length}`);
    console.info(
      `  categories with both bands >= ${MIN_BAND}  0` +
        `   <- lift needs this, and it is what is missing`,
    );

    if (examined.length > 0) {
      console.info("\nBand sizes so far  (structures, curated / other)");
      for (const one of [...examined].sort((a, b) => b.structures - a.structures).slice(0, 13)) {
        console.info(
          `  ${one.category.padEnd(24)} ${String(one.structures).padStart(5)} structures  ` +
            `${String(one.strongBand).padStart(4)} / ${String(one.weakBand).padStart(5)}`,
        );
      }
    }
    console.info(
      `\n  Re-extract, then ask again:  pnpm structures --extract 500   (repeat until remaining 0)\n`,
    );
    process.exit(0);
  }

  console.info(
    `\nBlock-type lift across ${banded.length} banded categories` +
      `  (${coverage.fingerprinted} of ${coverage.eligible} fingerprinted at ${EXTRACTOR_VERSION})`,
  );
  if (pctCoverage < 90) {
    console.info(
      `  WARNING: only ${pctCoverage.toFixed(1)}% re-extracted — these lifts will move. ` +
        `The v7 archetype collapse was a coverage artefact of exactly this kind.`,
    );
  }
  console.info("  (strong minus weak prevalence, in points; kept = cleared its own threshold)\n");
  console.info(`  ${"type".padEnd(18)} ${"kept in".padStart(8)}  ${"best".padStart(6)}  ${"median".padStart(6)}  best category`);
  for (const row of byType) {
    console.info(
      `  ${row.type.padEnd(18)} ${`${row.keptIn}/${banded.length}`.padStart(8)}  ` +
        `${(row.bestLift > 0 ? `+${row.bestLift}` : String(row.bestLift)).padStart(6)}  ` +
        `${(row.medianLift > 0 ? `+${row.medianLift}` : String(row.medianLift)).padStart(6)}  ${row.bestCategory ?? "—"}`,
    );
  }

  const unbanded = examined.filter((r) => !r.banded);
  if (unbanded.length > 0) {
    console.info(`\nNot banded, so excluded  (needs ${MIN_BAND} structures in each band)`);
    for (const one of unbanded) {
      console.info(
        `  ${one.category.padEnd(24)} ${String(one.strongBand).padStart(4)} curated / ${String(one.weakBand).padStart(5)} other`,
      );
    }
  }

  const detail = args.indexOf("--category");
  if (detail >= 0) {
    const wanted = args[detail + 1];
    const one = banded.find((c) => c.category === wanted);
    if (!one) {
      const seen = examined.find((c) => c.category === wanted);
      console.info(
        seen
          ? `\n  ${wanted}: not banded — ${seen.strongBand} curated / ${seen.weakBand} other, needs ${MIN_BAND} each`
          : `\n  ${wanted}: no evidence at all`,
      );
    } else {
      console.info(
        `\n${one.category} — ${one.structures} structures, ${one.strongBand} strong / ${one.weakBand} weak`,
      );
      console.info(`  ${"type".padEnd(18)} ${"strong".padStart(7)} ${"weak".padStart(6)} ${"lift".padStart(6)} ${"needs".padStart(6)}  density s/w  verdict`);
      for (const m of one.measured) {
        console.info(
          `  ${m.type.padEnd(18)} ${`${m.strongPrevalence}%`.padStart(7)} ${`${m.weakPrevalence}%`.padStart(6)} ` +
            `${(m.lift > 0 ? `+${m.lift}` : String(m.lift)).padStart(6)} ${m.requiredLift.toFixed(1).padStart(6)}  ` +
            `${m.strongDensity.toFixed(1)}/${m.weakDensity.toFixed(1)}`.padStart(11) +
            `  ${m.kept ? "KEPT" : (m.rejectedFor ?? "")}`,
        );
      }
    }
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--status")) {
  const rows = await archetypeSummary();
  if (rows.length === 0) {
    console.info("\nNo archetypes mined yet.\n");
  } else {
    console.info("\nArchetypes");
    for (const row of rows) {
      const skeleton = row.skeleton as { sections?: unknown[]; traits?: unknown[] };
      console.info(
        `  ${labelFor("function", row.category).padEnd(28)} v${row.version}  ` +
          `${String(row.distinctStructures).padStart(4)} structures / ${String(row.sourceCount).padStart(3)} sources  ` +
          `${skeleton.sections?.length ?? 0} sections`,
      );
    }
    console.info("");
  }
  process.exit(0);
}

const show = value("show");
if (show) {
  const a = await mineArchetype(show);
  if (!a) console.info(`\nNo labelled skills in "${show}".\n`);
  else render(a);
  console.info("");
  process.exit(0);
}

const mine = value("mine");
if (mine) {
  const result = await mineAndStore(mine, { force: args.includes("--force") });
  console.info(
    `\n${result.category}: ${result.stored ? `stored v${result.version}` : "not stored"} — ${result.reason}`,
  );
  if (result.archetype) render(result.archetype);
  console.info("");
  process.exit(0);
}

if (args.includes("--mine-all")) {
  const results = await mineAll({
    force: args.includes("--force"),
    onProgress: (m) => console.info(`  ${m}`),
  });
  console.info("\nResults");
  for (const r of results) {
    console.info(
      `  ${r.stored ? "✓" : "·"} ${r.category.padEnd(24)} ${r.stored ? `v${r.version}` : ""}  ${r.reason}`,
    );
  }
  console.info("");
}

process.exit(0);
