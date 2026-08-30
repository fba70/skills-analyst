import "dotenv/config";

import { EXTRACTOR_VERSION } from "../src/server/analytics/structure";
import { extractStructures, structureSummary } from "../src/server/analytics/structure-run";
import { categoryEvidence, sourceDiversity, templateClusters } from "../src/server/analytics/templates";

/**
 * Structural fingerprints — the evidence archetype mining reads (Doc 2 R3.2).
 *
 *   pnpm structures --status
 *   pnpm structures --extract 500     # a bounded slice; run again to continue
 *   pnpm structures --extract 500 --force   # re-extract at the current extractor version
 *   pnpm structures --unresolved      # heading strings no rule recognised
 *   pnpm structures --templates       # structural monoculture: the number that gates mining
 *
 * `--force` is the re-extract campaign: bump EXTRACTOR_VERSION first if the *rules*
 * changed, because that is the selector; use --force only to re-read bundles at the same
 * version, e.g. after a storage repair.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(`--${flag}`);
  const parsed = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

async function status() {
  const { totals, roles, eligible } = await structureSummary();
  const pct = (n: number) =>
    totals.fingerprinted > 0 ? `${Math.round((n / totals.fingerprinted) * 100)}%` : "—";

  console.info(`\nStructural fingerprints (extractor ${EXTRACTOR_VERSION})`);
  console.info(`  fingerprinted     ${totals.fingerprinted} of ${eligible} eligible`);
  console.info(`  avg headings      ${totals.avgHeadings}`);
  console.info(`  avg words         ${totals.avgWords}`);
  console.info(`  multi-file        ${totals.multiFile} (${pct(totals.multiFile)})`);
  console.info(`  has scripts/      ${totals.withScripts} (${pct(totals.withScripts)})`);
  console.info(`  has references/   ${totals.withReferences} (${pct(totals.withReferences)})`);

  if (roles.length > 0) {
    console.info("\nSection roles, by share of fingerprinted skills");
    for (const row of roles) {
      const share = totals.fingerprinted > 0 ? (row.count / totals.fingerprinted) * 100 : 0;
      const bar = "█".repeat(Math.round(share / 2.5));
      console.info(
        `  ${row.role.padEnd(16)} ${String(row.count).padStart(5)}  ${share.toFixed(1).padStart(5)}%  ${bar}`,
      );
    }
  }
  console.info("");
}

if (args.includes("--status")) {
  await status();
  process.exit(0);
}

if (args.includes("--extract")) {
  const report = await extractStructures({
    limit: value("extract") ?? 500,
    force: args.includes("--force"),
    onProgress: (m) => console.info(m),
  });
  console.info(
    `\nextracted ${report.extracted} · failed ${report.failed} · ` +
      `remaining ${report.remaining} · ` +
      `${report.unresolvedHeadings.length} unrecognised heading string(s)`,
  );
}

if (args.includes("--templates")) {
  const report = await templateClusters(10);
  console.info("\nStructural diversity");
  console.info(`  skills fingerprinted   ${report.fingerprinted}`);
  console.info(`  distinct structures    ${report.distinctStructures}`);
  console.info(`  diversity              ${report.diversityPercent}%  (distinct structures per skill)`);
  console.info(`  inside clusters of 10+ ${report.inLargeClusters}`);

  console.info("\nLargest template clusters");
  for (const cluster of report.clusters) {
    const shape =
      cluster.signature.length > 92 ? `${cluster.signature.slice(0, 89)}...` : cluster.signature;
    console.info(
      `\n  ${String(cluster.skills).padStart(5)} skills · ${cluster.sources} source(s) · ${cluster.topSource ?? "—"}`,
    );
    console.info(`        ${shape}`);
    console.info(`        e.g. ${cluster.sampleSlugs.join(", ")}`);
  }

  const diversity = await sourceDiversity(12);
  console.info("\n\nPer-source structural diversity  (skills / distinct structures)");
  for (const row of diversity) {
    const flag = row.diversity < 25 ? "  ← monoculture" : "";
    console.info(
      `  ${String(row.skills).padStart(5)} / ${String(row.structures).padStart(4)}  ` +
        `${String(row.diversity).padStart(3)}%  ${row.source}${flag}`,
    );
  }

  const evidence = await categoryEvidence();
  if (evidence.length > 0) {
    console.info("\n\nArchetype evidence per function  (raw skills vs distinct structures)");
    for (const row of evidence) {
      console.info(
        `  ${row.category.padEnd(24)} ${String(row.skills).padStart(5)} skills  ` +
          `${String(row.structures).padStart(4)} structures  ${row.sources} source(s)`,
      );
    }
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--unresolved")) {
  // Read from stored rows rather than re-extracting: this is exactly the list the LLM
  // heading pass would be asked to label, so it must reflect the corpus as fingerprinted.
  const { db } = await import("../src/server/db");
  const { sql } = await import("drizzle-orm");

  const result = await db.execute(sql`
    select heading->>'text' as text, count(*)::int as count
    from skill_structures,
         lateral jsonb_array_elements(headings) heading
    where extractor_version = ${EXTRACTOR_VERSION}
      and heading->>'role' is null
    group by 1
    order by count(*) desc
    limit 60
  `);

  const rows = result.rows as Array<{ text: string; count: number }>;
  console.info(`\nUnrecognised headings (${rows.length} shown, most common first)`);
  for (const row of rows) {
    console.info(`  ${String(row.count).padStart(4)}  ${row.text}`);
  }
  console.info("");
}

await status();
process.exit(0);
