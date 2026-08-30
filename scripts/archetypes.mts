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
