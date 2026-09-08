import "dotenv/config";

import { Client } from "pg";

import { BLOCK_TYPES } from "../src/lib/block-types";
import { MINER_VERSION } from "../src/server/analytics/archetype";
import { SECTION_ROLES } from "../src/server/analytics/structure";

/**
 * Stored archetypes carry usable, attributed, self-explaining guidance.
 *
 *   pnpm verify:archetypes
 *
 * Free — reads stored rows, mines nothing, calls no model.
 *
 * ## Why this exists
 *
 * On 2026-09-04 a re-mine over the newly-labelled corpus produced **five archetypes with
 * zero sections** and eight more with one or two. Nothing errored: `--mine-all` printed
 * thirteen ticks and a list of dropped sections, and `/build` and `/archetypes` served the
 * result. The regression was visible only to someone who read the summary closely and
 * thought the drops looked odd.
 *
 * The cause turned out to be real — at 97% coverage the weak band writes `steps` and
 * `references` almost as often as the curated band, so section presence stopped
 * discriminating — but "the measurement is correct" and "the output is usable" are different
 * questions, and only the first had an answer. An archetype with no sections and no traits
 * scaffolds nothing, and the builder would keep offering it.
 *
 * So the invariant is not "sections exist". It is **something usable exists**, plus the
 * things that make a published claim auditable: who it came from, and what was measured to
 * produce it.
 */

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

await c.connect();

type Row = {
  category: string;
  version: number;
  miner_version: string;
  sections: number;
  traits: number;
  contributors: number;
  measured: number;
  roles: string[] | null;
  kept_not_in_measured: number;
  blocks: Array<{
    type: string;
    lift: number;
    strongPrevalence: number;
    weakPrevalence: number;
    typicalPosition: number;
  }> | null;
  measured_blocks: Array<{ type: string; kept: boolean }> | null;
};

const { rows } = await c.query<Row>(`
  select a.category, a.version, a.miner_version,
    jsonb_array_length(coalesce(a.skeleton->'sections','[]'::jsonb)) as sections,
    jsonb_array_length(coalesce(a.skeleton->'traits','[]'::jsonb)) as traits,
    jsonb_array_length(coalesce(a.stats->'contributors','[]'::jsonb)) as contributors,
    jsonb_array_length(coalesce(a.stats->'measured','[]'::jsonb)) as measured,
    (select array_agg(s->>'role') from jsonb_array_elements(a.skeleton->'sections') s) as roles,
    (select count(*) from jsonb_array_elements(a.skeleton->'sections') s
      where not exists (
        select 1 from jsonb_array_elements(a.stats->'measured') m where m->>'role' = s->>'role'
      ))::int as kept_not_in_measured,
    /* Null when the key is absent, which is a different fact from an empty array — a row
       mined before miner 3.0.0 measured no blocks, and reporting that as "no block
       separated the bands" would be a claim about the corpus made from a missing column. */
    a.skeleton->'blocks' as blocks,
    a.stats->'measuredBlocks' as measured_blocks
  from archetypes a
  where a.org_id is null
    and a.version = (select max(version) from archetypes b
                      where b.category = a.category and b.org_id is null and b.axis = a.axis)
  order by a.category
`);

console.info(`\nLatest archetype per category (${rows.length} rows)`);

check("every latest row is at the current miner", rows.every((r) => r.miner_version === MINER_VERSION),
  rows.filter((r) => r.miner_version !== MINER_VERSION).map((r) => `${r.category}@${r.miner_version}`).join(", "));

/**
 * The invariant that actually protects the product. Sections may legitimately be zero — the
 * corpus is allowed to have no structural consensus — but a row with neither sections nor
 * traits scaffolds an empty form and teaches nothing.
 */
const useless = rows.filter((r) => r.sections + r.traits === 0);
check("every archetype carries sections or traits", useless.length === 0,
  useless.map((r) => r.category).join(", "));

check("every archetype is attributed (R3.4)", rows.every((r) => r.contributors > 0),
  rows.filter((r) => r.contributors === 0).map((r) => r.category).join(", "));

/**
 * The evidence behind the skeleton, including the rejects. Without it a section that missed
 * the threshold by two points is indistinguishable from one never considered.
 */
check("every archetype stores what it measured", rows.every((r) => r.measured > 0),
  rows.filter((r) => r.measured === 0).map((r) => r.category).join(", "));

check("every kept section appears in the measurements", rows.every((r) => r.kept_not_in_measured === 0),
  rows.filter((r) => r.kept_not_in_measured > 0).map((r) => r.category).join(", "));

const validRoles = new Set<string>(SECTION_ROLES as readonly string[]);
const badRole = rows.filter((r) => (r.roles ?? []).some((x) => !validRoles.has(x)));
check("every skeleton role is in the section vocabulary", badRole.length === 0,
  badRole.map((r) => `${r.category}:${(r.roles ?? []).filter((x) => !validRoles.has(x)).join("/")}`).join(", "));

/*
 * ---------------------------------------------------------------------------------------
 * The block grammar (Doc 6 RW.1), added at miner 3.0.0
 * ---------------------------------------------------------------------------------------
 *
 * Blocks are why 3.0.0 exists: at full corpus coverage the best *section* lift across the
 * three largest categories is +10, while `reference-pointer` clears its threshold in 11 of
 * 13 categories at a median +18 and `decision-rule` in 10 of 13 at +21. Section presence
 * had stopped discriminating and this is the level that still does.
 *
 * These checks are shaped like the section ones on purpose. The v8 regression was not a
 * crash — it was a correct measurement whose output was unusable, served by two pages with
 * nothing asserting otherwise. Blocks are a second chance to make exactly that mistake.
 */
console.info(`\nThe block grammar`);

check(
  "every latest archetype measured blocks",
  rows.every((r) => r.blocks !== null),
  rows.filter((r) => r.blocks === null).map((r) => r.category).join(", ") ||
    "a null here means the row predates miner 3.0.0 — re-mine",
);

const validBlocks = new Set<string>(BLOCK_TYPES as readonly string[]);
const badBlock = rows.filter((r) => (r.blocks ?? []).some((b) => !validBlocks.has(b.type)));
check(
  "every kept block is in the block vocabulary",
  badBlock.length === 0,
  badBlock
    .map((r) => `${r.category}:${(r.blocks ?? []).filter((b) => !validBlocks.has(b.type)).map((b) => b.type).join("/")}`)
    .join(", "),
);

/**
 * Every type considered, not only the ones that won.
 *
 * `stats.measured` was added for sections after diagnosing the v8 collapse took four
 * throwaway scripts rebuilding numbers the miner had already computed and discarded. The
 * same argument applies here with more force: the decision *not* to publish block
 * anti-patterns rests on `anti-example` measuring −3, and that number has to be on the row
 * or the reasoning in `archetype.ts` cites evidence nobody can check.
 */
const shortMeasured = rows.filter((r) => (r.measured_blocks ?? []).length !== BLOCK_TYPES.length);
check(
  `all ${BLOCK_TYPES.length} block types are measured and recorded, winners and losers`,
  shortMeasured.length === 0,
  shortMeasured.map((r) => `${r.category}:${(r.measured_blocks ?? []).length}`).join(", "),
);

const keptNotMeasured = rows.filter((r) => {
  const measured = new Set((r.measured_blocks ?? []).map((m) => m.type));
  return (r.blocks ?? []).some((b) => !measured.has(b.type));
});
check(
  "every kept block appears in the measurements",
  keptNotMeasured.length === 0,
  keptNotMeasured.map((r) => r.category).join(", "),
);

/**
 * A grammar, not a set — so the order has to be real.
 *
 * Both the archetype page and the builder render this list top to bottom and tell the reader
 * it is the order a curated skill puts them in. If the miner ever sorted by lift instead,
 * every one of those sentences would silently become false while looking identical.
 */
const misordered = rows.filter((r) => {
  const blocks = r.blocks ?? [];
  return blocks.some((b, i) => i > 0 && b.typicalPosition < blocks[i - 1].typicalPosition);
});
check(
  "blocks are stored in document order, which is what the pages claim",
  misordered.length === 0,
  misordered.map((r) => r.category).join(", "),
);

const badPosition = rows.filter((r) =>
  (r.blocks ?? []).some((b) => b.typicalPosition < 0 || b.typicalPosition > 1),
);
check(
  "every position is a normalised 0–1 fraction, not a raw block index",
  badPosition.length === 0,
  badPosition.map((r) => r.category).join(", "),
);

const inconsistentLift = rows.filter((r) =>
  (r.blocks ?? []).some((b) => b.lift !== b.strongPrevalence - b.weakPrevalence),
);
check(
  "each block's lift is its two bands subtracted, so the chart and the number agree",
  inconsistentLift.length === 0,
  inconsistentLift.map((r) => r.category).join(", "),
);

/**
 * The deliberate omission, asserted so it cannot be undone by accident.
 *
 * `anti-example` measures −3 corpus-wide and −5 in `review`; `stance` −6. Miner 3.0.0
 * publishes neither as guidance, because the anti-example detector fires on markers (❌,
 * "common mistakes") and may therefore be measuring house style rather than the absence of
 * failure-mode knowledge. Emitting the negative would tell authors to write fewer
 * anti-examples, and a wrong instruction to delete knowledge costs more than a wrong
 * instruction to add some.
 *
 * A future miner may well publish block anti-patterns — with a better detector, or with
 * fifty skills read by hand. What it must not do is start emitting them because a sort
 * order changed. So the reasoning lives in `archetype.ts` and the constraint lives here.
 */
const negative = rows.filter((r) => (r.blocks ?? []).some((b) => b.lift <= 0));
check(
  "no block with zero or negative lift is published as guidance",
  negative.length === 0,
  negative
    .map((r) => `${r.category}:${(r.blocks ?? []).filter((b) => b.lift <= 0).map((b) => b.type).join("/")}`)
    .join(", ") || "negative lift is measured and stored, never offered to an author",
);

{
  /*
   * The corpus-level answer to Doc 6's central bet, printed rather than asserted.
   *
   * Whether blocks discriminate better than sections is a finding about the corpus, and the
   * corpus is free to change its mind. A check would turn a real result into a test that
   * fails when the evidence moves; a line of output puts it in front of whoever runs this.
   */
  const withBlocks = rows.filter((r) => (r.blocks ?? []).length > 0);
  const liftsByType = new Map<string, number[]>();
  for (const row of withBlocks) {
    for (const b of row.blocks ?? []) {
      const list = liftsByType.get(b.type) ?? [];
      list.push(b.lift);
      liftsByType.set(b.type, list);
    }
  }
  const ranked = [...liftsByType.entries()]
    .map(([type, lifts]) => ({
      type,
      categories: lifts.length,
      median: lifts.sort((a, b) => a - b)[Math.floor(lifts.length / 2)],
    }))
    .sort((a, b) => b.categories - a.categories || b.median - a.median);

  console.info(
    `  note  ${withBlocks.length} of ${rows.length} categories publish blocks; ` +
      `${ranked.length} types earn a place somewhere`,
  );
  for (const r of ranked.slice(0, 5)) {
    console.info(
      `        ${r.type.padEnd(18)} ${String(r.categories).padStart(2)}/${rows.length} categories · median +${r.median}`,
    );
  }
  const never = BLOCK_TYPES.filter((type) => !liftsByType.has(type));
  if (never.length > 0) {
    console.info(
      `        earns nothing anywhere: ${never.join(", ")}` +
        `\n        — a type that never separates the bands is a pruning candidate (Doc 6 §7)`,
    );
  }
}

/*
 * ---------------------------------------------------------------------------------------
 * Stored is not served
 * ---------------------------------------------------------------------------------------
 *
 * Every check above reads the table with raw SQL. That proves the miner wrote the blocks and
 * proves nothing about whether an author ever sees them — and "written correctly, dropped on
 * the way out" is the failure this codebase has hit most often: `validatePending` read
 * unscoped and validated nothing, `recordUsage` wrote unscoped and metered nothing, R6.2's
 * activity feed silently omitted the most interesting event in the loop. Each one looked
 * complete from the side that wrote the row.
 *
 * The block grammar now travels through two more hops before it reaches anybody — the public
 * read path, then the builder's scaffold, which is also what the generation prompt is built
 * from. Both are exercised here rather than trusted. Free: no model call, no write.
 */
console.info(`\nThe read path actually carries them`);

{
  const { archetypeDetail } = await import("../src/server/analytics/archetype-read");
  const { buildScaffold } = await import("../src/server/builder/scaffold");

  /* The category with the most blocks, so the check has something to lose. */
  const richest = [...rows].sort((a, b) => (b.blocks ?? []).length - (a.blocks ?? []).length)[0];
  const stored = (richest.blocks ?? []).length;

  const detail = await archetypeDetail(richest.category);
  check(
    "the public read path returns the blocks it stored",
    (detail?.skeleton.blocks ?? []).length === stored,
    `${richest.category}: ${(detail?.skeleton.blocks ?? []).length} read vs ${stored} stored`,
  );

  const scaffold = await buildScaffold(richest.category);
  check(
    "the builder's scaffold carries them, so the prompt and the form agree",
    (scaffold?.blocks ?? []).length === stored,
    `${richest.category}: ${(scaffold?.blocks ?? []).length} offered vs ${stored} stored`,
  );
  /*
   * R5.2: a suggestion must be traceable to the archetype element it came from. A block
   * offered without its two bands is an unsourced assertion in an interface whose whole
   * argument is that its advice is measured.
   */
  check(
    "every offered block carries the evidence that earned it",
    (scaffold?.blocks ?? []).every(
      (b) => b.label.length > 0 && b.blurb.length > 0 && b.lift > 0 && b.strongPrevalence > 0,
    ),
    "prevalence and lift travel with the ask, or the builder is asserting a corpus fact with no source",
  );

  /* A category the gate refused must not acquire block guidance from nowhere. */
  const unmined = await buildScaffold("automate-browser");
  check(
    "a category with no mined blocks offers none rather than a default list",
    (unmined?.blocks ?? []).length === (rows.find((r) => r.category === "automate-browser")?.blocks ?? []).length,
    "there is no structurally required block type, so a hand-written fallback would be invented evidence",
  );
}

/**
 * Append-only. A regeneration writes a new row; it never edits the previous one, which is
 * what makes R7.2 reproducibility and R3.5 evolution-diffing possible at all.
 */
const { rows: dupes } = await c.query<{ n: string }>(
  `select count(*)::text as n from (
     select category, version from archetypes where org_id is null
     group by category, version, axis having count(*) > 1) t`,
);
check("no category/version is written twice", dupes[0].n === "0", `${dupes[0].n} duplicated`);

const { rows: hist } = await c.query<{ n: string }>(
  `select count(*)::text as n from archetypes where org_id is null`,
);
check("earlier versions are retained as history", Number(hist[0].n) > rows.length,
  `${hist[0].n} rows across ${rows.length} categories`);

console.info(`\n${pass} passed, ${fail} failed\n`);
await c.end();
process.exit(fail > 0 ? 1 : 0);
