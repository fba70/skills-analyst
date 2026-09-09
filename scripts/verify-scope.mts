import "dotenv/config";

import { Client } from "pg";

import { BLOCK_TYPES } from "../src/lib/block-types";
import {
  analyseCohesion,
  analyseDisclosure,
  centroid,
  cosine,
  DISCLOSURE_MAX_CENTRALITY,
  DISCLOSURE_MIN_WORDS,
  MAX_TYPE_PURITY,
  meanPairwiseCosine,
  MIN_BLOCKS_TO_JUDGE,
  MIN_CLUSTER_BLOCKS,
  MIN_SPLIT_SEPARATION,
  NEVER_OFFLOAD,
  SCOPE_ANALYSER_VERSION,
  SCOPE_VERDICT_META,
  SCOPE_VERDICTS,
  splitInTwo,
  typeAlignment,
} from "../src/lib/scope";
import { DISCLOSURE_HINT_BYTES } from "../src/lib/tokens";

/**
 * The scope analyser refuses to be confidently wrong (Doc 6 RW.10 / RW.11, plan step C5).
 *
 *   pnpm verify:scope
 *
 * **Free, and almost all of it needs no database and no network** — the metric is arithmetic
 * over vectors, so synthetic documents can be built with the exact shapes that matter and the
 * verdict asserted against them. That is the point of keeping the maths in `src/lib/scope.ts`:
 * a fixture drawn from the corpus can stop reproducing the case it was chosen for, and a
 * fixture built by hand cannot.
 *
 * ## The three properties this file exists to protect
 *
 * 1. **A split along block type is not a scope finding.** Cluster any document's blocks and you
 *    get two clusters; the strongest seam in block text is frequently *guardrails against
 *    procedures*, which every good skill has. The suite builds exactly that document and
 *    requires `type-aligned`, then builds a genuinely two-subject one and requires
 *    `split-candidate` — both directions, because a detector that answers one way to everything
 *    passes a one-directional test.
 * 2. **The verdict is reproducible.** k-means from a random seed gives a different answer on a
 *    re-run of the same document, so "is this two skills" would depend on when you asked. The
 *    seeding is deterministic and the suite runs the same input twice.
 * 3. **Disclosure never proposes moving the load-bearing parts.** A restructurer that hollows
 *    out a document while reporting a token saving is D4's "saving-only rule is a document
 *    shredder", one level down.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/**
 * A vector near a named direction, with a deterministic wobble.
 *
 * Three dimensions is enough: cosine does not care how many there are, and a 1,536-wide fixture
 * would hide what the test is actually saying. The wobble is a fixed function of the index, not
 * `Math.random()`, so a failure is reproducible by whoever reads it.
 */
function near(axis: 0 | 1 | 2, i: number, spread = 0.12): number[] {
  const base = [0, 0, 0];
  base[axis] = 1;
  const wobble = (n: number) => ((Math.sin((i + 1) * (n + 7)) + 1) / 2) * spread;
  return base.map((value, n) => value + wobble(n));
}

console.info("\nThe arithmetic");

check(
  "cosine is 1 for a vector against itself and 0 for orthogonal ones",
  Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9 && Math.abs(cosine([1, 0, 0], [0, 1, 0])) < 1e-9,
);
check(
  "a zero vector is 0 rather than NaN",
  cosine([0, 0, 0], [1, 0, 0]) === 0,
  "NaN would propagate silently into a stored real column",
);
check(
  "the centroid of one direction is that direction",
  cosine(centroid([[1, 0, 0], [1, 0, 0]]), [1, 0, 0]) > 0.999,
);
check(
  "mean pairwise cosine is higher for one cluster than for two",
  meanPairwiseCosine(Array.from({ length: 20 }, (_, i) => near(0, i))) >
    meanPairwiseCosine([
      ...Array.from({ length: 10 }, (_, i) => near(0, i)),
      ...Array.from({ length: 10 }, (_, i) => near(1, i)),
    ]),
);

console.info("\nA document that really is two subjects");

const twoSubjects = {
  vectors: [
    ...Array.from({ length: 9 }, (_, i) => near(0, i)),
    ...Array.from({ length: 9 }, (_, i) => near(1, i)),
  ],
  /*
   * Types deliberately *interleaved* across both halves. A real two-skill document has
   * procedures and rules on both sides of its seam, and mixing them here is what makes the
   * next check about subject rather than about type.
   */
  types: Array.from({ length: 18 }, (_, i) =>
    (["procedure", "decision-rule", "guardrail", "example", "output-spec"] as const)[i % 5],
  ),
};

const two = analyseCohesion(twoSubjects);
check("it is reported as a split candidate", two.verdict === "split-candidate", two.verdict);
check(
  "with the two halves roughly even",
  Math.min(two.clusters[0].length, two.clusters[1].length) >= MIN_CLUSTER_BLOCKS,
  `${two.clusters[0].length} / ${two.clusters[1].length}`,
);
check(
  "and separation above the threshold",
  (two.separation ?? 0) >= MIN_SPLIT_SEPARATION,
  `${(two.separation ?? 0).toFixed(3)} ≥ ${MIN_SPLIT_SEPARATION}`,
);
check(
  "the same input twice gives the same answer",
  JSON.stringify(analyseCohesion(twoSubjects)) === JSON.stringify(two),
  "a random k-means seed would make a stored verdict depend on when it was asked",
);

console.info("\nThe confound: a split that block type explains");

/*
 * The failure this whole module is built around, reproduced before the fix is asserted.
 *
 * Same geometry as the document above — two well-separated groups — but here the groups **are**
 * the block types: every guardrail in one, every procedure in the other. The naive analyser
 * calls this two skills. It is one skill with rules and steps, which is what a good skill looks
 * like, and shipping that verdict would have told a large part of the corpus to cut itself up.
 */
const typeSplit = {
  vectors: twoSubjects.vectors,
  types: [
    ...Array.from({ length: 9 }, () => "guardrail"),
    ...Array.from({ length: 9 }, () => "procedure"),
  ],
};

const naivePurity = typeAlignment(typeSplit.types, splitInTwo(typeSplit.vectors));
check(
  "the naive reading of it is a confident split",
  (1 -
    cosine(
      centroid(splitInTwo(typeSplit.vectors)[0].map((i) => typeSplit.vectors[i])),
      centroid(splitInTwo(typeSplit.vectors)[1].map((i) => typeSplit.vectors[i])),
    )) >= MIN_SPLIT_SEPARATION,
  "so the fixture still reproduces the bug",
);
check(
  "and the type purity is what gives it away",
  naivePurity !== null && naivePurity > MAX_TYPE_PURITY,
  `${naivePurity?.toFixed(3)} > ${MAX_TYPE_PURITY}`,
);
check(
  "so the analyser reports type-aligned, not a decomposition",
  analyseCohesion(typeSplit).verdict === "type-aligned",
  analyseCohesion(typeSplit).verdict,
);

console.info("\nAnd the mirror image: unclassified must not fake an alignment");

check(
  "a split whose blocks are mostly untyped reports no purity at all",
  typeAlignment(
    Array.from({ length: 18 }, () => null),
    splitInTwo(twoSubjects.vectors),
  ) === null,
  "58% of corpus blocks carry no type; counting absence as a type would refuse real findings",
);
check(
  "and that document is still judged on separation",
  analyseCohesion({ vectors: twoSubjects.vectors, types: Array.from({ length: 18 }, () => null) })
    .verdict === "split-candidate",
);

console.info("\nA cohesive document, and the two ways of having nothing to say");

const cohesive = {
  vectors: Array.from({ length: 20 }, (_, i) => near(0, i)),
  types: Array.from({ length: 20 }, () => "procedure"),
};
check("one subject reads as cohesive", analyseCohesion(cohesive).verdict === "cohesive");
check(
  "a short document is not-measurable, never cohesive",
  analyseCohesion({
    vectors: Array.from({ length: MIN_BLOCKS_TO_JUDGE - 1 }, (_, i) => near(0, i)),
    types: Array.from({ length: MIN_BLOCKS_TO_JUDGE - 1 }, () => null),
  }).verdict === "not-measurable",
  "a five-block skill that reads as two topics is a short skill",
);
check(
  "the two empty answers are different words",
  SCOPE_VERDICT_META.cohesive.blurb !== SCOPE_VERDICT_META["not-measurable"].blurb,
);
check(
  "a lopsided split is cohesive, not a weak candidate",
  analyseCohesion({
    vectors: [...Array.from({ length: 17 }, (_, i) => near(0, i)), near(1, 0), near(1, 1)],
    types: Array.from({ length: 19 }, () => null),
  }).verdict === "cohesive",
  `one odd passage is not a second skill (floor ${MIN_CLUSTER_BLOCKS})`,
);
check(
  "every verdict has a label and its own blurb",
  SCOPE_VERDICTS.every((v) => SCOPE_VERDICT_META[v].label.length > 0) &&
    new Set(SCOPE_VERDICTS.map((v) => SCOPE_VERDICT_META[v].blurb)).size === SCOPE_VERDICTS.length,
);

console.info("\nThe control the first corpus run needed");

/*
 * `--calibrate` glues two unrelated documents together and measures the seam, because separation
 * on its own has no reference point — the first corpus run returned 51% split candidates at a
 * threshold nothing had validated. The pairing arithmetic is checked here, free: a glued pair
 * must separate more than either of its halves did, or the control cannot calibrate anything.
 */
const docA = { vectors: Array.from({ length: 14 }, (_, i) => near(0, i)), types: Array.from({ length: 14 }, () => null) };
const docB = { vectors: Array.from({ length: 14 }, (_, i) => near(1, i)), types: Array.from({ length: 14 }, () => null) };
const glued = analyseCohesion({
  vectors: [...docA.vectors, ...docB.vectors],
  types: [...docA.types, ...docB.types],
});
check(
  "two unrelated documents glued together separate further than either alone",
  (glued.separation ?? 0) > (analyseCohesion(docA).separation ?? 0) &&
    (glued.separation ?? 0) > (analyseCohesion(docB).separation ?? 0),
  `glued ${(glued.separation ?? 0).toFixed(3)}`,
);
check(
  "and the glued pair is a split candidate, or the control has nothing to point at",
  glued.verdict === "split-candidate",
  glued.verdict,
);

console.info("\nDisclosure proposes nothing on a document that is not too big");

const bigVectors = [
  ...Array.from({ length: 10 }, (_, i) => near(0, i)),
  ...Array.from({ length: 4 }, (_, i) => near(2, i)),
];
const bigTypes: Array<string | null> = [
  ...Array.from({ length: 10 }, () => "procedure"),
  ...Array.from({ length: 4 }, () => "example"),
];
const words = bigVectors.map((_, i) => (i >= 10 ? 200 : 30));
const tokens = words.map((w) => w * 4);

const under = analyseDisclosure({
  vectors: bigVectors,
  types: bigTypes,
  words,
  tokens,
  bodyBytes: DISCLOSURE_HINT_BYTES - 1,
  hintBytes: DISCLOSURE_HINT_BYTES,
});
check(
  "under the validator's own hint size, nothing is proposed",
  !under.oversized && under.candidates.length === 0 && under.movableTokens === 0,
  "a restructurer that fires on every skill is a linter nobody leaves on",
);

const over = analyseDisclosure({
  vectors: bigVectors,
  types: bigTypes,
  words,
  tokens,
  bodyBytes: DISCLOSURE_HINT_BYTES + 1,
  hintBytes: DISCLOSURE_HINT_BYTES,
});
check(
  "over it, the long peripheral blocks are proposed",
  over.oversized && over.candidates.length === 4 && over.candidates.every((c) => c.index >= 10),
  `${over.candidates.length} candidate(s)`,
);
check(
  "the short central ones are not",
  over.candidates.every((c) => c.words >= DISCLOSURE_MIN_WORDS),
);
check(
  "furthest from the centre is proposed first",
  over.candidates.every((c, i) => i === 0 || over.candidates[i - 1].centrality <= c.centrality),
);
check(
  "and the saving is the sum of what would move",
  over.movableTokens === over.candidates.reduce((sum, c) => sum + c.tokens, 0),
);

console.info("\nDisclosure never proposes moving the parts that do the work");

const guardrailHeavy = analyseDisclosure({
  vectors: bigVectors,
  types: [...Array.from({ length: 10 }, () => "procedure"), ...Array.from({ length: 4 }, () => "guardrail")],
  words,
  tokens,
  bodyBytes: DISCLOSURE_HINT_BYTES + 1,
  hintBytes: DISCLOSURE_HINT_BYTES,
});
check(
  "a long peripheral guardrail stays in the body",
  guardrailHeavy.candidates.length === 0,
  "an agent that must follow a pointer to find a prohibition has already had the chance to break it",
);
check(
  "every never-offload type is a real block type",
  NEVER_OFFLOAD.every((type) => (BLOCK_TYPES as readonly string[]).includes(type)),
  NEVER_OFFLOAD.join(", "),
);
check(
  "centrality and length are both required, not either",
  DISCLOSURE_MAX_CENTRALITY > 0 && DISCLOSURE_MAX_CENTRALITY < 1 && DISCLOSURE_MIN_WORDS > 0,
);

console.info("\nThe threshold is the validator's, not a second opinion");

check(
  "the disclosure hint comes from lib/tokens, where structural-lint put it",
  DISCLOSURE_HINT_BYTES === 15_000,
  "a display with its own idea of `too big` eventually disagrees with the analyzer",
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.skill_scope') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — apply the migration: pnpm db:migrate");
  } else {
    check(
      "the table carries a row-level security policy",
      Number(
        (await c.query<{ n: string }>(`select count(*)::text as n from pg_policies where tablename = 'skill_scope'`))
          .rows[0].n,
      ) >= 1,
    );

    /*
     * The same rule `skill_blocks` holds and `verify:blocks` asserts: **no column may hold body
     * text.** A stored cluster is block ids, so a proposed split resolves live through the same
     * licence gate the block library uses and a withdrawn skill stops being quotable at once.
     * Checked against `information_schema` rather than against today's data, because clean data
     * says nothing about the next migration.
     */
    const { rows: columns } = await c.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'skill_scope'`,
    );
    const textish = columns.filter((col) => col.data_type === "text").map((col) => col.column_name);
    check(
      "no free-text column: every text column is an identifier or a closed vocabulary",
      textish.every((name) =>
        ["org_id", "analyser_version", "embedder_version", "verdict"].includes(name),
      ),
      textish.join(", ") || "none",
    );
    check(
      "the verdict column only ever holds a value from the vocabulary",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from skill_scope
            where verdict <> all (string_to_array($1, ','))`,
          [SCOPE_VERDICTS.join(",")],
        )
      ).rows[0].n === "0",
    );
    check(
      "the analyser version is part of the key, so a threshold change cannot re-label silently",
      Number(
        (
          await c.query<{ n: string }>(
            `select count(*)::text as n from pg_indexes
              where tablename = 'skill_scope' and indexdef ilike '%analyser_version%'
                and indexdef ilike '%unique%'`,
          )
        ).rows[0].n,
      ) >= 1,
    );

    /*
     * Execute the two raw queries, because the type checker cannot.
     *
     * A `sql` template is a string: the first version of the selector joined on a column that
     * does not exist and typechecked perfectly, then died on the first live run. Both of these
     * are free — one returns ids, the other counts — so there is no reason for a suite that
     * spends nothing to leave them unexecuted.
     */
    const { pendingScopeVersions, scopeSummary } = await import("../src/server/analytics/scope");

    let selectorRan = false;
    let pending = 0;
    try {
      pending = (await pendingScopeVersions(5)).length;
      selectorRan = true;
    } catch (error) {
      check("the re-run selector executes", false, (error as Error).message.slice(0, 120));
    }
    if (selectorRan) {
      check(
        "the re-run selector executes and returns version ids",
        true,
        `${pending} pending in the first 5`,
      );
    }

    try {
      const summary = await scopeSummary();
      check(
        "the status query executes and its coverage is bounded by the corpus",
        summary.analysed <= summary.total,
        `${summary.analysed} of ${summary.total}`,
      );
    } catch (error) {
      check("the status query executes", false, (error as Error).message.slice(0, 120));
    }

    const { rows: stored } = await c.query<{ n: string; current: string }>(
      `select count(*)::text as n,
              count(*) filter (where analyser_version = $1)::text as current
         from skill_scope`,
      [SCOPE_ANALYSER_VERSION],
    );
    if (stored[0].current === "0") {
      console.info(
        "  skip  nothing analysed at this analyser version — `pnpm scope --run 200` (COSTS MONEY, a few cents)",
      );
    } else {
      const { rows: sane } = await c.query<{ bad: string }>(
        `select count(*)::text as bad from skill_scope
          where analyser_version = $1
            and (cohesion < -1 or cohesion > 1
                 or (separation is not null and (separation < 0 or separation > 2))
                 or blocks < 0 or movable_tokens < 0)`,
        [SCOPE_ANALYSER_VERSION],
      );
      check("every stored measurement is in range", sane[0].bad === "0", `${sane[0].bad} out of range`);

      const { rows: unjudged } = await c.query<{ bad: string }>(
        `select count(*)::text as bad from skill_scope
          where analyser_version = $1 and verdict = 'not-measurable' and blocks >= $2`,
        [SCOPE_ANALYSER_VERSION, MIN_BLOCKS_TO_JUDGE],
      );
      check(
        "nothing is called not-measurable that had enough blocks to measure",
        unjudged[0].bad === "0",
        "the two empty answers must not leak into each other",
      );

      const { rows: purity } = await c.query<{ bad: string }>(
        `select count(*)::text as bad from skill_scope
          where analyser_version = $1 and verdict = 'split-candidate'
            and type_purity is not null and type_purity > $2`,
        [SCOPE_ANALYSER_VERSION, MAX_TYPE_PURITY],
      );
      check(
        "no stored split candidate is one the block types explain",
        purity[0].bad === "0",
        "the confound, asserted against the data as well as the code",
      );

      const { rows: finding } = await c.query<{ verdict: string; n: string }>(
        `select verdict, count(*)::text as n from skill_scope
          where analyser_version = $1 group by verdict order by count(*) desc`,
        [SCOPE_ANALYSER_VERSION],
      );
      console.info(
        `  note  ${stored[0].current} analysed · ` +
          finding.map((row) => `${row.verdict}: ${row.n}`).join(", "),
      );
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
