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
