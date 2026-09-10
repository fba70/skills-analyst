import "dotenv/config";

import { EXTRACTOR_VERSION } from "../src/server/analytics/structure";
import { extractStructures, structureSummary } from "../src/server/analytics/structure-run";
import { categoryEvidence, sourceDiversity, templateClusters } from "../src/server/analytics/templates";

/**
 * Structural fingerprints — the evidence archetype mining reads (Doc 2 R3.2).
 *
 *   pnpm structures --status
 *   pnpm structures --extract 500     # a bounded slice; run again to continue
 *   pnpm structures --extract 500 --drain   # repeat until nothing is left (what you want)
 *   pnpm structures --extract 500 --force   # re-extract at the current extractor version
 *   pnpm structures --unresolved      # heading strings no rule recognised
 *   pnpm structures --probe 250       # block detection, DRY: reads bundles, writes nothing
 *   pnpm structures --probe 250 --samples guardrail   # read real matches of one type
 *   pnpm structures --blocks          # stored block coverage (Doc 6 RW.1)
 *   pnpm structures --tools           # stored tool references + decision rules per category (Doc 7 P0)
 *   pnpm structures --probe 300 --tools   # the same table, DRY, from real bundles — the answer today
 *   pnpm structures --probe 300 --tools --samples npx   # read the lines behind one token
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
  /**
   * `--drain` repeats until the queue is empty, which is what anyone re-extracting the corpus
   * actually wants.
   *
   * The slice limit exists because a serverless invocation is capped; from a terminal there
   * is no ceiling, and the honest consequence of *not* offering this was a re-extract that
   * needed **a hundred invocations by hand** and predictably stopped at 3%. The pipeline
   * command already had `--loop` for exactly this reason; the extractor should have had it
   * from the start.
   *
   * Stops on an idle pass rather than a pass count, so it cannot spin once the work is gone,
   * and stops on a pass that extracted nothing but still reports work remaining — that means
   * every candidate in the slice failed to load, and looping would retry the same broken
   * bundles for ever.
   */
  const drain = args.includes("--drain");
  const limit = value("extract") ?? 500;
  let totals = { extracted: 0, blocks: 0, failed: 0, remaining: 0 };
  let pass = 0;

  for (;;) {
    pass += 1;
    const report = await extractStructures({
      limit,
      force: args.includes("--force"),
      onProgress: (m) => console.info(m),
    });
    totals = {
      extracted: totals.extracted + report.extracted,
      blocks: totals.blocks + report.blocks,
      failed: totals.failed + report.failed,
      remaining: report.remaining,
    };
    console.info(
      `${drain ? `pass ${pass}: ` : "\n"}extracted ${report.extracted} · ${report.blocks} blocks · ` +
        `failed ${report.failed} · remaining ${report.remaining}`,
    );

    if (!drain) break;
    if (report.remaining === 0) {
      console.info("\nnothing left to extract");
      break;
    }
    if (report.extracted === 0) {
      console.info(
        `\nstopping: a whole pass extracted nothing while ${report.remaining} remain — ` +
          `every candidate in the slice failed to load, so looping would retry the same ones`,
      );
      break;
    }
  }

  if (drain && pass > 1) {
    console.info(
      `\ntotal across ${pass} passes: ${totals.extracted} extracted · ${totals.blocks} blocks · ` +
        `${totals.failed} failed · ${totals.remaining} remaining`,
    );
  }
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

if (args.includes("--blocks")) {
  const { blockSummary } = await import("../src/server/analytics/blocks-run");
  const { totals, blockTotals, byType } = await blockSummary();
  const share =
    blockTotals.blocks > 0 ? (blockTotals.classified / blockTotals.blocks) * 100 : 0;

  const { structureSummary: sum } = await import("../src/server/analytics/structure-run");
  const { eligible } = await sum();
  const covered = eligible > 0 ? (totals.versions / eligible) * 100 : 0;

  console.info(`\nBlocks (extractor ${EXTRACTOR_VERSION})`);
  if (covered < 90) {
    /**
     * The shares below are over what has been extracted, not over the corpus, and the
     * extraction order is not random — `extractStructures` selects without an ORDER BY, so
     * a partial run is whatever physical order the planner returned. Measured divergence
     * on the first 510: `anti-example` read 52% of skills here against 23% on a
     * `order by random()` probe of 300. Same detector, different sample. Saying so is the
     * difference between a partial number and a wrong one.
     */
    console.info(
      `  PARTIAL: ${totals.versions} of ${eligible} extracted (${covered.toFixed(1)}%), and the` +
        ` selection is not random — treat the shares below as a sample, not the corpus.`,
    );
  }
  console.info(`  fingerprints          ${totals.versions}`);
  console.info(`  with any block        ${totals.withBlocks}`);
  console.info(`  with a classified one ${totals.withClassified}`);
  console.info(`  blocks                ${blockTotals.blocks}`);
  console.info(`  classified            ${blockTotals.classified} (${share.toFixed(1)}%)`);
  console.info(`  avg blocks per skill  ${totals.avgBlocks}`);
  console.info(`  avg token estimate    ${totals.avgTokens}`);

  if (byType.length > 0) {
    console.info("\nSkills carrying at least one block of each type");
    for (const row of byType) {
      const pctOf = totals.versions > 0 ? (row.skills / totals.versions) * 100 : 0;
      console.info(
        `  ${row.type.padEnd(18)} ${String(row.skills).padStart(6)}  ${pctOf.toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(pctOf / 2.5))}`,
      );
    }
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--tools")) {
  /**
   * Tool references and decision rules — the measurement Doc 7 starts from (step P0).
   *
   * The vocabulary in `src/lib/tools.ts` is written *from* this table, not before it. With
   * `--probe N` the table comes from real bundles read now and written nowhere; without it,
   * from what extraction stored, which is empty until the 2.1.0 re-extract has run — and the
   * coverage line above the table says so, because a short table over 3% of the corpus reads
   * as a quiet corpus.
   */
  const { decisionRuleCoverage, probeTools, toolRefSummary } = await import(
    "../src/server/analytics/tools-run"
  );
  const categoryIndex = args.indexOf("--category");
  const category = categoryIndex >= 0 ? args[categoryIndex + 1] : undefined;
  const sampleIndex = args.indexOf("--samples");
  const sampleToken =
    sampleIndex >= 0 && args[sampleIndex + 1] && !args[sampleIndex + 1].startsWith("--")
      ? args[sampleIndex + 1]
      : undefined;

  if (args.includes("--probe")) {
    const report = await probeTools({ limit: value("probe") ?? 300, category, sampleToken });
    const pct = (n: number) => (report.versions > 0 ? ((n / report.versions) * 100).toFixed(0) : "0");
    console.info(
      `\nTool references, dry run over ${report.versions} bundles` +
        (category ? ` in ${category}` : "") +
        `  (extractor ${EXTRACTOR_VERSION} as in the source tree; nothing written)`,
    );
    console.info(`  failed to load           ${report.failed}`);
    console.info(`  with any tool reference  ${report.withAnyTool}  (${pct(report.withAnyTool)}%)`);
    console.info(`  with allowed-tools       ${report.withAllowedTools}  (${pct(report.withAllowedTools)}%)`);
    console.info(
      `  with a decision rule     ${report.decisionRules.skills}  (${pct(report.decisionRules.skills)}%)` +
        `  · ${report.decisionRules.meanPerSkill} rules per skill among those`,
    );

    console.info(
      "\nTokens  (repos · skills · refs · code / prose / frontmatter) — candidates, not a vocabulary;" +
        " sorted by distinct repositories so a generator cannot head the table",
    );
    for (const row of report.tokens.slice(0, 60)) {
      console.info(
        `  ${row.token.padEnd(26)} ${String(row.sources).padStart(4)} ${String(row.skills).padStart(5)}  ${String(row.refs).padStart(6)}   ` +
          `${String(row.code).padStart(5)} / ${String(row.prose).padStart(5)} / ${String(row.frontmatter).padStart(4)}`,
      );
    }
    if (report.tokens.length > 60) console.info(`  … ${report.tokens.length - 60} more tokens`);
    if (report.samples.length > 0) {
      console.info(`\nSamples for ${sampleToken}  (source · excerpt; local diagnostic, never stored)`);
      for (const sample of report.samples) console.info(`  · ${sample}`);
    }

    if (report.pins.length > 0) {
      console.info("\nVersion pins  (the roughest detector; read the noise before building on it)");
      for (const pin of report.pins.slice(0, 30)) {
        console.info(`  ${`${pin.tool} ${pin.version}`.padEnd(30)} ${String(pin.skills).padStart(5)}`);
      }
    }
    console.info("");
    process.exit(0);
  }

  /*
   * The columns arrive with a migration and the version bump arrives with the code, so there is
   * a window where this runs against a table that cannot answer. Say so and carry on to the
   * decision-rule half, which needs neither.
   */
  const summary = await toolRefSummary().catch((error: unknown) => {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "42703") return null;
    throw error;
  });
  if (!summary) {
    console.info(
      `\nTool references, stored — columns absent: the 2.1.0 migration is not applied yet` +
        ` (pnpm db:generate, read the SQL, pnpm db:migrate). \`--probe 300 --tools\` answers now.`,
    );
  } else {
    const covered = summary.eligible > 0 ? (summary.fingerprinted / summary.eligible) * 100 : 0;
    console.info(`\nTool references, stored (extractor ${summary.extractorVersion})`);
    console.info(
      `  fingerprinted  ${summary.fingerprinted} of ${summary.eligible} (${covered.toFixed(1)}%)` +
        (covered < 90
          ? "  — PARTIAL: read the table as a sample. `pnpm structures --extract 500 --drain` fills it," +
            " or `--probe 300 --tools` answers now from real bundles."
          : ""),
    );
  }
  if (summary && summary.fingerprinted > 0) {
    console.info(`  with any tool reference  ${summary.withAnyTool}`);
    console.info(`  with allowed-tools       ${summary.withAllowedTools}`);
    console.info("\nTokens  (skills · refs)");
    for (const row of summary.tokens) {
      console.info(`  ${row.token.padEnd(26)} ${String(row.skills).padStart(6)}  ${String(row.refs).padStart(7)}`);
    }
    if (summary.pins.length > 0) {
      console.info("\nVersion pins  (skills)");
      for (const pin of summary.pins) {
        console.info(`  ${`${pin.tool} ${pin.version}`.padEnd(30)} ${String(pin.skills).padStart(6)}`);
      }
    }
  }

  const rules = await decisionRuleCoverage();
  console.info(
    `\nDecision rules per function category` +
      (rules.extractorVersion
        ? `  (block counts at extractor ${rules.extractorVersion}${rules.fallback ? " — the newest with rows; nothing is extracted at " + EXTRACTOR_VERSION + " yet" : ""})`
        : "  (no fingerprints stored)"),
  );
  for (const row of rules.categories) {
    const share = row.skills > 0 ? (row.with_rules / row.skills) * 100 : 0;
    console.info(
      `  ${row.category.padEnd(20)} ${String(row.skills).padStart(6)} skills  ${String(row.with_rules).padStart(6)} with a rule  ` +
        `${share.toFixed(0).padStart(3)}%  ${String(row.mean_rules).padStart(4)} per skill among those`,
    );
  }
  console.info("");
  process.exit(0);
}

if (args.includes("--probe")) {
  /**
   * Block detection, dry — reads real bundles, writes nothing (Doc 6 RW.1).
   *
   * The workflow this exists for: change a cue in `blocks.ts`, probe a few hundred real
   * skills, read the distribution, and only then spend a re-extract. `verify:blocks` proves
   * each rule *can* fire on a fixture built to make it fire; only this can tell you that
   * one rule swallows the corpus or that a type never fires on real text.
   */
  const { probeBlocks } = await import("../src/server/analytics/blocks-run");
  const categoryIndex = args.indexOf("--category");
  const sampleIndex = args.indexOf("--samples");
  const report = await probeBlocks({
    limit: value("probe") ?? 200,
    category: categoryIndex >= 0 ? args[categoryIndex + 1] : undefined,
    sampleCount: sampleIndex >= 0 ? 14 : 0,
    // `--samples` alone samples the unclassified; `--samples guardrail` samples that type,
    // which is the check a distribution cannot make for you.
    sampleType:
      sampleIndex >= 0 && args[sampleIndex + 1] && !args[sampleIndex + 1].startsWith("--")
        ? args[sampleIndex + 1]
        : "unclassified",
  });

  const share = report.blocks > 0 ? (report.classified / report.blocks) * 100 : 0;
  console.info(`\nBlock detection, dry run over ${report.versions} bundles`);
  console.info(`  blocks            ${report.blocks}  (${(report.blocks / Math.max(1, report.versions)).toFixed(1)} per skill)`);
  console.info(`  classified        ${report.classified}  (${share.toFixed(1)}%)`);
  console.info(`  failed to load    ${report.failed}`);

  console.info("\nBy type  (blocks · share of blocks · skills carrying at least one)");
  const rows = Object.entries(report.byType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of rows) {
    const pctOfBlocks = report.blocks > 0 ? (count / report.blocks) * 100 : 0;
    const skillShare =
      report.versions > 0 ? ((report.skillsWithType[type] ?? 0) / report.versions) * 100 : 0;
    console.info(
      `  ${type.padEnd(18)} ${String(count).padStart(5)}  ${pctOfBlocks.toFixed(1).padStart(5)}%  ` +
        `${skillShare.toFixed(0).padStart(3)}% of skills  ${"█".repeat(Math.round(pctOfBlocks / 2))}`,
    );
  }

  console.info("\nBy rule  (a rule that swallows the corpus is visible here by name)");
  for (const [rule, count] of Object.entries(report.byRule).sort((a, b) => b[1] - a[1])) {
    console.info(`  ${rule.padEnd(36)} ${String(count).padStart(5)}`);
  }

  if (report.unclassifiedShape.length > 0) {
    console.info("\nWhere the unclassified mass sits  (parent role / segment shape)");
    for (const row of report.unclassifiedShape) {
      console.info(`  ${row.shape.padEnd(28)} ${String(row.count).padStart(5)}`);
    }
  }

  if (report.samples.length > 0) {
    console.info("\nSamples  (local diagnostic; never stored)");
    for (const sample of report.samples) console.info(`  · ${sample}`);
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
