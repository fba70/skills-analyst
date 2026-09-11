import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  CLUSTER_SIMILARITY,
  DECISION_PARAMETERS,
  PARAMETER_ANALYSER_VERSION,
  PARAMETER_EMBEDDER_VERSION,
  cosine,
  proposeClusters,
  shapeOf,
  resolveParameter,
  vocabularyReady,
  type ClusterInput,
} from "../src/lib/decision-surface";
import { MODEL_DEFAULTS, MODEL_TASKS, MODEL_TASK_META } from "../src/lib/models";
import { EMBEDDER_VERSION } from "../src/server/analytics/embeddings";

/**
 * The decision surface, mined per category (Doc 7 RD.5, plan step P7).
 *
 *   pnpm verify:decision-surface
 *
 * Free. The extraction and the clustering are the two metered paths and are asserted against the
 * source rather than run; the clustering *maths* is pure, so it is exercised with no corpus, no
 * API key and no fixture that might have stopped reproducing its case.
 *
 * ## The five properties this file exists to protect
 *
 * 1. **A vocabulary nobody curated publishes nothing.** An extracted name is a word a model
 *    chose. Every reader asks `vocabularyReady()` first, and the CLI says which gate is shut.
 * 2. **The vocabulary and the miner version move together.** `mineAndStore` skips on an unchanged
 *    skeleton *and* a matching `MINER_VERSION`, so a dimension that lands without a bump reaches
 *    exactly zero archetypes, silently. That trap caught 2.1.0's attribution and 3.0.0's blocks.
 *    It is a check here, so it cannot catch a third.
 * 3. **The bands and the threshold are imported, never restated.** Parameter lift and block lift
 *    are comparable only if they are literally the same code.
 * 4. **Examined and absent are different facts.** The table is keyed on the examination, so a
 *    skill that branches on nothing is a row — the bug that made P1's resolver re-read 28,035
 *    versions for 776 passes.
 * 5. **No corpus prose is stored, and none reaches an author.** Names and values are model output
 *    about a passage; the passage stays in the bundle behind the licence gate.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const strip = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

console.info("\nAn uncurated vocabulary publishes nothing");

check(
  "the vocabulary starts empty, and says so rather than guessing a plausible list",
  DECISION_PARAMETERS.length === 0 && !vocabularyReady(),
  "Doc 7 RD.5: the first sample is read by a person before a label is written",
);
check(
  "so no extracted name resolves to anything yet",
  resolveParameter("environment") === null && resolveParameter("change size") === null,
);

/*
 * The trap that keeps the two halves together. `mineAndStore` skips when the skeleton is
 * unchanged and the miner version matches, so a dimension curated into existence without a bump
 * would reach zero archetypes and report success — which is exactly what happened to 2.1.0's
 * attribution and 3.0.0's blocks. Asserting the *relationship* rather than either value means
 * whoever writes the first cluster label is told, in a red check, what else has to move.
 */
const miner = strip("src/server/analytics/archetype.ts");
const minerVersion = /MINER_VERSION\s*=\s*"([^"]+)"/.exec(miner)?.[1] ?? "";
check(
  "the miner version is readable, so the rule below can be enforced",
  /^\d+\.\d+\.\d+$/.test(minerVersion),
  minerVersion,
);
check(
  "curating the vocabulary requires bumping the miner in the same change",
  DECISION_PARAMETERS.length === 0 || minerVersion !== "3.0.0",
  DECISION_PARAMETERS.length === 0
    ? `nothing curated yet, so ${minerVersion} is correct`
    : `${DECISION_PARAMETERS.length} parameters curated at miner ${minerVersion} — a stored skeleton gaining a key needs a new version, or it reaches no archetype at all`,
);

console.info("\nThe clustering maths, with no corpus and no API key");

/* Three names for one idea, and one for a different one. The vectors are written out. */
const env: ClusterInput = { name: "environment", sources: 40, count: 90, vector: [1, 0, 0] };
const env2: ClusterInput = { name: "target environment", sources: 12, count: 20, vector: [0.97, 0.24, 0] };
const env3: ClusterInput = { name: "env", sources: 6, count: 9, vector: [0.99, 0.14, 0] };
const size: ClusterInput = { name: "change size", sources: 30, count: 55, vector: [0, 1, 0] };

check(
  "cosine is 1 for a vector against itself and 0 for an orthogonal pair",
  Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9,
);
check(
  "a zero vector is 0 rather than NaN",
  cosine([0, 0], [1, 1]) === 0,
  "the naive division answers NaN, which sorts as neither near nor far",
);

const clusters = proposeClusters([env2, size, env3, env]);
check(
  "three spellings of one idea are proposed as one cluster",
  clusters.length === 2 && clusters[0].members.length === 3,
  `${clusters.length} clusters: ${clusters.map((c) => c.members.length).join("/")}`,
);
check(
  "and the proposed label is the most-sourced spelling, not whichever row came first",
  clusters[0].proposedLabel === "environment",
  clusters[0].proposedLabel,
);
check(
  "a genuinely different parameter stays its own cluster",
  clusters.some((c) => c.members.length === 1 && c.members[0].name === "change size"),
);
check(
  "clusters are ordered by distinct repositories, never by occurrences",
  clusters[0].sources >= clusters[1].sources,
  "one generator's eight hundred skills are one data point about the corpus",
);

/* Determinism: the same input twice, built independently, must group identically. */
const again = proposeClusters(JSON.parse(JSON.stringify([env2, size, env3, env])) as ClusterInput[]);
check(
  "the proposal is deterministic",
  JSON.stringify(again) === JSON.stringify(clusters),
  "a grouping that changes between two runs of one input is one nobody can review",
);

const strict = proposeClusters([env, env2, env3, size], 0.999);
check(
  "a stricter threshold splits rather than silently keeping the loose answer",
  strict.length === 4,
  `${strict.length} clusters at 0.999 against ${clusters.length} at ${CLUSTER_SIMILARITY}`,
);

const run = strip("src/server/analytics/parameters-run.ts");

console.info("\nWhat shape a block is, by rule alone");

check(
  "a pipe table is a table",
  shapeOf("| Input | Verdict |\n|---|---|\n| none | skip |") === "table",
);
check(
  "an if sentence is a conditional",
  shapeOf("If the environment is production, require two approvals.") === "conditional",
);
/*
 * The defect reading the probe's output found. An arrow-form bullet list is a decision table
 * without the pipes, and filing it under `list` — the shape that means *nothing to extract* —
 * understated the share the whole spend decision is made on.
 */
check(
  "an arrow-form bullet list is a table without the pipes, not a list",
  shapeOf("- Greenfield feature → default EXPANSION\n- Bug fix → default HOLD SCOPE") ===
    "conditional",
);
check(
  "a plain bulleted list is still a list",
  shapeOf("- Do not force-push.\n- Do not rewrite history.") === "list",
);
check(
  "and a paragraph that merely contains the word is prose",
  shapeOf(
    "The signer must match the path wallet, and the response differs if that is not the case.",
  ) === "prose",
  "the noise floor: a conditional word in the third clause types the passage, not the shape",
);

console.info("\nThe versions that keep two populations apart");

check(
  "the clustering composition is its own version, not A6's",
  (PARAMETER_EMBEDDER_VERSION as string) !== (EMBEDDER_VERSION as string) &&
    PARAMETER_EMBEDDER_VERSION.includes("parameter-name"),
  "A6 embeds a skill's claim; this embeds two words naming one input",
);
/*
 * The composition, pinned after a real run refuted the first one. 1.0.0 embedded the name plus
 * its observed values and could not merge `file type` with `file types` — 0.531, because one
 * skill's values were `md, txt` and the other's `images, pdfs`. A composition that pushes a
 * plural apart is not separating homonyms.
 */
check(
  "the vector is the name alone, and the version says so",
  PARAMETER_EMBEDDER_VERSION.endsWith(":parameter-name") &&
    !PARAMETER_EMBEDDER_VERSION.includes("values"),
  PARAMETER_EMBEDDER_VERSION,
);
check(
  "and the embedder is handed the name, not the name plus its values",
  /const texts = rows\.map\(\(row\) => row\.name\)/.test(run),
  "the values are still stored — they are evidence for a person, not input to a vector",
);
check(
  "the analyser version is in the stored key, so a prompt change re-reads",
  /analyser_version/.test(strip("src/server/db/schema/parameters.ts")) &&
    /skill_parameters_uq/.test(strip("src/server/db/schema/parameters.ts")),
  PARAMETER_ANALYSER_VERSION,
);

console.info("\nThe model task");

check(
  "corpus extraction has its own task, separate from the builder's",
  (MODEL_TASKS as readonly string[]).includes("decisionSurface") &&
    (MODEL_TASKS as readonly string[]).includes("parameters"),
  "an operator tuning a 23,476-call corpus pass must not change what a draft does",
);
check("it has a default and a blurb", Boolean(MODEL_DEFAULTS.decisionSurface) && Boolean(MODEL_TASK_META.decisionSurface));

console.info("\nWhat the run may and may not do");

check(
  "the selector skips skills with no decision rule at all",
  /block_counts->>'decision-rule'/.test(run),
  "a count the fingerprint already carries, so nothing is fetched to learn it has no rules",
);
check(
  "and skips a version already examined at this analyser version",
  /not exists/.test(run) && /analyser_version/.test(run),
  "a re-run is free for everything done",
);
check(
  "public, canonical, indexed, stored — the four corpus filters",
  /s\.status = 'indexed'/.test(run) &&
    /s\.org_id is null/.test(run) &&
    /s\.canonical_skill_id is null/.test(run) &&
    /v\.content_stored = true/.test(run),
  "a private skill feeding a public archetype is what RC.5 and OQ-C2 forbid",
);
check(
  "one bundle read per skill, not one per block",
  /readMarkerBody/.test(run) && !/readFragment/.test(run),
  "C5's first draft made 36 round trips to an EU bucket for one document",
);
check(
  "the corpus passage arrives fenced and labelled as data",
  /DECISION_RULES/.test(run) && /untrusted data/.test(run),
  "R7.3: a skill is a document written by a stranger to steer an agent",
);
check(
  "the budget is checked before the loop and again inside it",
  (run.match(/assertWithinBudget/g) ?? []).length >= 2,
);
check(
  "a refusal stops and keeps rather than discarding the pass",
  /stopped = true/.test(run) && /break/.test(run),
);
check(
  "the batch size is a fuse that refuses rather than a number that clamps",
  /refusing to extract/.test(run),
  "MAX_BATCH's sibling",
);
check(
  "a row is written whether or not anything was found",
  /blocksRead/.test(run) && /onConflictDoUpdate/.test(run),
  "absence of rows must not mean both 'not examined' and 'branches on nothing'",
);
check(
  "the model is resolved once per call, so the ledger and the row name the same one",
  /modelFor\("decisionSurface"\)/.test(run),
);
check(
  "the source of a skill is read from the version, never from the skill row",
  !/skills\s+\w+\s+on[^\n]*\n?[^\n]*source_id/.test(run) && /v\.source_id/.test(run),
  "skills has no source_id; skill_versions does, and this query died on the difference",
);
check(
  "vectors are used and dropped, never stored",
  !/insert\(skillEmbeddings\)/.test(run) && /embedBatch/.test(run),
  "a third incomparable population beside A6's and C5's is what this avoids",
);

console.info("\nWhat the mine may and may not do");

const mine = strip("src/server/analytics/parameters-mine.ts");

check(
  "the bands, the threshold and the floor are imported from the miner",
  /representatives/.test(mine) &&
    /liftStandardError/.test(mine) &&
    /MIN_LIFT/.test(mine) &&
    /LIFT_SIGMA/.test(mine) &&
    /MIN_STRONG_PREVALENCE/.test(mine) &&
    /MIN_BAND/.test(mine),
  "a near-proxy agreed to within a point once and would have hidden the contradiction",
);
check(
  "and none of them is redefined here",
  !/const MIN_LIFT/.test(mine) && !/const MIN_BAND/.test(mine) && !/function liftStandardError/.test(mine),
);
check(
  "the rejection sentence is built before the verdict, so a near miss leaves a trace",
  mine.indexOf("rejectedFor =") < mine.indexOf("kept: rejectedFor === null"),
);
check(
  "the mine writes no archetype",
  !/mineAndStore/.test(mine) && !/insert\(archetypes\)/.test(mine),
  "publication is a deliberate miner bump, not a side effect of measuring",
);
check(
  "the array is built as array[…], never as a bound JS array",
  /any\(array\[/.test(mine) && !/=\s*any\(\$\{ids\}\)/.test(mine),
  "drizzle renders a JS array as a row constructor — four times, at runtime only",
);
check(
  "and the scan can see the wrong form",
  /= any\(\$\{ids\}\)/.test(["= any(${", "ids})"].join("")),
  "assembled at runtime, so the control is not a literal this very scan would report",
);

console.info("\nWhat is stored, and what never is");

const schema = strip("src/server/db/schema/parameters.ts");
const FORBIDDEN = new Set(["text", "body", "passage", "excerpt", "sentence", "quote", "prose"]);
const storesProse = (column: string) => column.split("_").some((word) => FORBIDDEN.has(word));
check(
  "the scan can see a column that would hold a sentence",
  storesProse("passage_text") && storesProse("body") && !storesProse("blocks_read"),
  "a scan that matches nothing passes for the wrong reason",
);
check(
  "no column on the table could hold one",
  !(schema.match(/\n\s{4}(\w+):/g) ?? [])
    .map((m) => m.trim().replace(":", ""))
    .some((column) => storesProse(column.replace(/([A-Z])/g, "_$1").toLowerCase())),
  "skill_blocks holds offsets and no text; this holds our reading, not their prose",
);

const cli = strip("scripts/archetypes.mts");
check(
  "the measurement command refuses before it prints a table nobody can trust",
  /cannot be answered yet/.test(cli) && /curated parameters            0/.test(cli),
  "a table of zeros reads as 'no signal' when the truth is 'nothing measured'",
);
check(
  "and it warns when coverage is partial rather than presenting a partial run as a sample",
  /these prevalences will move/.test(cli),
  "the selector has no ORDER BY, so a partial extraction is not random",
);

console.info("\nAgainst the real table");

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
    `select to_regclass('public.skill_parameters') is not null as present`,
  );
  if (!exists[0].present) {
    console.info(
      "  skip  skill_parameters absent — run pnpm db:generate, read the SQL, then pnpm db:migrate",
    );
  } else {
    check(
      "the table carries a row-level security policy",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_policies where tablename = 'skill_parameters'`,
        )
      ).rows[0].n !== "0",
      "a new table with no policy is invisible to the app rather than merely unprotected",
    );
    check(
      "one examination per version per analyser",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes
            where tablename = 'skill_parameters' and indexname = 'skill_parameters_uq'`,
        )
      ).rows[0].n === "1",
    );

    /*
     * The selector, executed rather than asserted to exist. C5 shipped a pending selector that
     * joined a column living on another table: it typechecked, because a `sql` template is a
     * string, and it died on its first live execution with the suite green.
     */
    const { pendingParameterVersions, parameterSummary } = await import(
      "../src/server/analytics/parameters-run"
    );
    const pending = await pendingParameterVersions(3);
    check(
      "the pending selector runs and returns ids",
      Array.isArray(pending),
      `${pending.length} waiting of the first 3 asked for`,
    );

    /*
     * Every query this step owns, executed. `clusterProposals`' own query shipped with
     * `skills.source_id` in it — a column that lives on `skill_versions` — and died on its first
     * live run, with this suite green: it asserted three of the four selectors and not the
     * fourth. That is C5's lesson arriving again in the same file that quotes it, so the rule is
     * now literal: if this step can run a query, the suite runs it.
     *
     * The free half only. `clusterProposals` embeds, and a suite that starts spending the first
     * time somebody extracts anything is a suite people stop running.
     */
    const { parameterNameCounts } = await import("../src/server/analytics/parameters-run");
    const names = await parameterNameCounts({ limit: 5 });
    check(
      "the cluster query runs and groups names by distinct repository",
      Array.isArray(names),
      `${names.length} names at two or more sources`,
    );
    check(
      "and every row it returns carries a source count and a value list",
      names.every((row) => typeof row.sources === "number" && Array.isArray(row.values)),
      "a null array from a filtered array_agg is the shape that crashes a caller later",
    );

    const summary = await parameterSummary();
    check(
      "the summary runs and counts the population this dimension can describe",
      summary.eligible > 0,
      `${summary.eligible} skills carry a decision rule · ${summary.examined} examined`,
    );
    check(
      "examined never exceeds eligible",
      summary.examined <= summary.eligible,
      "a coverage share above 100% is the fan-out join bug that made --blocks announce 50% at completion",
    );

    /* The mine, run for real against an empty vocabulary: it must measure nothing and not throw. */
    const { mineParameterLift } = await import("../src/server/analytics/parameters-mine");
    const mined = await mineParameterLift("review");
    check(
      "the mine executes and reports its bands",
      mined !== null && mined.strongBand > 0 && mined.weakBand > 0,
      mined ? `${mined.strongBand} curated / ${mined.weakBand} other` : "no representatives",
    );
    check(
      "and measures nothing while the vocabulary is empty",
      (mined?.measured.length ?? 0) === 0,
      "an unresolved name is not a parameter; it is a word a model chose",
    );
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
