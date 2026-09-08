import "dotenv/config";

import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  CALLS_PER_TASK,
  deltaFor,
  formatDelta,
  MAX_MATRIX_TASKS,
  MIN_MATRIX_TASKS,
  summariseMatrix,
  type MatrixCell,
} from "../src/lib/matrix";
import { MODEL_DEFAULTS, MODEL_TASKS } from "../src/lib/models";
import { rateFor } from "../src/lib/llm-pricing";
import { OUTCOME_KINDS, UNIMPLEMENTED_KINDS } from "../src/lib/outcomes";

/**
 * The with/without matrix measures a difference, and refuses to invent one (plan step D3).
 *
 *   pnpm verify:matrix
 *
 * Free. The arithmetic needs nothing and the database half writes run rows directly rather than
 * calling a model — the counting is the subject, and driving a model would make the checks
 * depend on what it said.
 *
 * ## What is actually at risk
 *
 * A delta is a subtraction between two arms, which gives it a failure mode none of the other
 * measurements have: **half a measurement renders as a perfect result.**
 *
 *   1. **An incomplete task averaged in.** The budget refuses partway through, the with-arm ran
 *      and the without-arm did not, and the skill appears to take the task from nothing to
 *      everything. This is the one that would ship silently and read as a triumph.
 *   2. **A matrix arm leaking into Skill CI.** D1 reads the newest run per case. A
 *      *without-the-skill* failure — the arm working exactly as intended — would land there as
 *      the case's current verdict, look like a regression, and block the publish.
 *   3. **An `error` counted as a failure.** In the without-arm that flatters the skill; in the
 *      with-arm it damns it. Either way it is our outage moving their number.
 *   4. **A negative delta hidden.** The most valuable output of this whole milestone.
 */

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
function skip(name: string, why: string): void {
  console.info(`  skip  ${name} — ${why}`);
  skipped += 1;
}

const cell = (model: string, withSkill: boolean, passed: number, total: number): MatrixCell => ({
  model,
  withSkill,
  passed,
  total,
});

// ---------------------------------------------------------------------------------------
console.info("\nThe delta, and when there is not one");
// ---------------------------------------------------------------------------------------

/**
 * Reproduced first: the naive subtraction turns a missing arm into a perfect result.
 *
 * Treating an absent without-arm as a zero pass rate is the obvious repair and the dangerous
 * one — `1 - 0` is a flawless +100, and it is exactly what a budget refusal partway through a
 * run produces. A number that is wrong in the flattering direction is the one nobody questions.
 */
{
  const halfMeasured = [cell("m", true, 4, 4)];
  const naive =
    (halfMeasured[0].passed / halfMeasured[0].total) -
    /* the missing arm, read as zero */ 0;
  check(
    "the naive subtraction reads a missing arm as a perfect improvement",
    naive === 1,
    "+100 points from one arm",
  );
  check("the real delta declines instead", deltaFor(halfMeasured, "m").delta === null);
}

{
  const both = [cell("m", true, 8, 10), cell("m", false, 5, 10)];
  const row = deltaFor(both, "m");
  check(
    "a real delta is the difference of the two rates",
    row.delta !== null && Math.abs(row.delta - 0.3) < 1e-9,
    formatDelta(row.delta) ?? "",
  );

  /*
   * The finding this milestone exists for. Nothing clamps, and the sign survives formatting.
   */
  const worse = [cell("m", true, 3, 10), cell("m", false, 7, 10)];
  const negative = deltaFor(worse, "m");
  check(
    "a skill that made results worse reports a negative",
    negative.delta !== null && negative.delta < 0,
    formatDelta(negative.delta) ?? "",
  );
  check(
    "and the sign survives all the way to the label",
    formatDelta(negative.delta)?.startsWith("-") === true,
    formatDelta(negative.delta) ?? "",
  );
}

/*
 * Per model, because "it helps" is usually "it helps this one". A summary that averaged a
 * measured model with an unmeasured one would dilute the only result there is.
 */
{
  const cells = [
    cell("big", true, 9, 10),
    cell("big", false, 8, 10),
    cell("small", true, 8, 10),
    cell("small", false, 3, 10),
  ];
  const { perModel, overallDelta } = summariseMatrix(cells);
  check(
    "each model gets its own delta",
    perModel.length === 2 &&
      Math.abs((perModel.find((r) => r.model === "small")?.delta ?? 0) - 0.5) < 1e-9,
    perModel.map((r) => `${r.model} ${formatDelta(r.delta)}`).join(", "),
  );
  check(
    "and the overall figure is the mean of the models that have one",
    overallDelta !== null && Math.abs(overallDelta - 0.3) < 1e-9,
    formatDelta(overallDelta) ?? "",
  );

  const oneMeasured = summariseMatrix([cell("big", true, 9, 10), cell("small", true, 8, 10)]);
  check(
    "a model with only one arm contributes nothing rather than a zero",
    oneMeasured.overallDelta === null,
    "an unmeasured model must not dilute a measured one",
  );
}

check(
  "the run has a fuse and the cost per task is stated",
  MAX_MATRIX_TASKS > 0 && MAX_MATRIX_TASKS <= 20 && CALLS_PER_TASK === 8,
  `${MAX_MATRIX_TASKS} tasks × ${CALLS_PER_TASK} calls`,
);

check(
  "and a thin result is marked",
  MIN_MATRIX_TASKS >= 3,
  `below ${MIN_MATRIX_TASKS} complete tasks`,
);

// ---------------------------------------------------------------------------------------
console.info("\nThe last uncollected outcome kind");
// ---------------------------------------------------------------------------------------

check(
  "eval-delta is still in the vocabulary",
  (OUTCOME_KINDS as readonly string[]).includes("eval-delta"),
);

/**
 * The list that said `eval-delta` was uncollected has to shrink in the same change that starts
 * writing it.
 *
 * `verify:outcomes` asserts every kind named there has **zero stored rows**, so leaving it
 * behind would turn that suite red the first time a matrix ran — which is the correction the
 * `flagged` entry had to make the hard way, after the Loop panel spent weeks telling an
 * operator a dependency was outstanding on a platform that was recording through it.
 */
check(
  "and it is no longer claimed to be uncollected",
  !(UNIMPLEMENTED_KINDS as readonly string[]).includes("eval-delta"),
  UNIMPLEMENTED_KINDS.length === 0
    ? "nothing is uncollected now — R6.3's collection half is complete"
    : UNIMPLEMENTED_KINDS.join(", "),
);

for (const task of ["evalAgent", "evalAgentB"] as const) {
  check(
    `${task} is a setting with a priced default`,
    MODEL_TASKS.includes(task) &&
      rateFor(MODEL_DEFAULTS[task]).inputPerMTok !== rateFor("nope/nope").inputPerMTok,
    MODEL_DEFAULTS[task],
  );
}

/*
 * The two arms must be different models, or the matrix measures one model twice and reports it
 * as agreement between two.
 */
check(
  "the two arms are different models",
  MODEL_DEFAULTS.evalAgent !== MODEL_DEFAULTS.evalAgentB,
  `${MODEL_DEFAULTS.evalAgent} vs ${MODEL_DEFAULTS.evalAgentB}`,
);

// ---------------------------------------------------------------------------------------
console.info("\nWhat the runner is careful about");
// ---------------------------------------------------------------------------------------

{
  const matrix = readFileSync("src/server/evals/matrix.ts", "utf8");
  const store = readFileSync("src/server/evals/store.ts", "utf8");

  /**
   * The interaction that would have shipped silently.
   *
   * D1 takes the newest run per case as the case's state. A matrix writes a run per arm, and the
   * without-arm is *supposed* to fail — so without this filter a successful matrix would make
   * every golden task look freshly broken, and the publish gate would call it a regression.
   */
  check(
    "Skill CI ignores matrix arms entirely",
    /isNull\(evalRuns\.withSkill\)/.test(store),
    "a without-the-skill failure must not read as a regression",
  );
  check(
    "and the matrix writes the arm on every row it stores",
    /withSkill,\s*$/m.test(matrix) || /withSkill,/.test(matrix),
  );

  check(
    "the two arms have separate prompts rather than one with a conditional",
    /const WITH_SYSTEM/.test(matrix) && /const WITHOUT_SYSTEM/.test(matrix),
    "the difference between them is the experiment",
  );
  check(
    "the without-arm is never handed the document",
    (() => {
      const withoutBlock = matrix.slice(
        matrix.indexOf("const WITHOUT_SYSTEM"),
        matrix.indexOf("const JUDGE_SYSTEM"),
      );
      return withoutBlock.length > 0 && !/input\.body/.test(withoutBlock);
    })(),
  );

  check(
    "an errored cell is excluded from both numerator and denominator",
    /verdict !== "error"/.test(matrix),
    "a refusal in the without-arm would otherwise read as the skill helping",
  );
  check(
    "only tasks with all four cells count towards a delta",
    /set\.size === 4/.test(matrix),
  );
  check(
    "a cell already measured at this document is skipped",
    /cellExists\(/.test(matrix),
    "eight calls a task makes a second press the most expensive no-op in the product",
  );
  check(
    "the signal is written only for a published skill with a real delta",
    /input\.publishedSkillId && overallDelta !== null && completeTasks > 0/.test(matrix),
  );
  check(
    "both arms are budget-checked before they spend",
    (matrix.match(/assertWithinBudget\("eval", input\.orgId\)/g) ?? []).length >= 2,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nAgainst the real tables");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("matrix checks", "no database connection — the checks above are complete without it");
}

let draftId: string | null = null;

if (connected) {
  const hasColumn = await owner.query<{ n: string }>(
    `select count(*)::text as n from information_schema.columns
      where table_name = 'eval_runs' and column_name = 'with_skill'`,
  );
  const orgId = (await owner.query<{ id: string }>(`select id from organization limit 1`)).rows[0]
    ?.id;

  if (hasColumn.rows[0].n === "0") {
    skip("matrix checks", "eval_runs.with_skill does not exist — apply migrations/0035");
  } else if (!orgId) {
    skip("matrix checks", "no organisation exists — sign up once, then re-run");
  } else {
    try {
      const { createForTest } = await import("../src/server/builder/drafts");
      const { setDraftBlocks } = await import("../src/server/builder/blocks");
      const { createEval, contentHashOf, evalStates } = await import("../src/server/evals/store");
      const { runMatrixWithModels } = await import("../src/server/evals/matrix");

      draftId = await createForTest(
        {
          name: `verify-matrix-${Date.now()}`,
          purpose: "Probe the with/without matrix. Removed at the end of this run.",
          context: null,
          category: "review",
          domain: null,
          dialect: "anthropic_skill",
          sectionInputs: {},
          scaffoldSections: [],
        },
        orgId,
        (await owner.query<{ id: string }>(`select id from "user" limit 1`)).rows[0]?.id ?? null,
      );

      const built = await setDraftBlocks(
        draftId,
        orgId,
        [{ form: "content", depth: null, type: "procedure", text: "Read the plan in full." }],
        { reason: "edited" },
      );
      const hash = contentHashOf(built.body);

      const task = await createEval({
        draftId,
        orgId,
        userId: null,
        kind: "golden-task",
        prompt: "Summarise this plan",
        expectation: "Names every destroyed resource",
      });
      const probe = await createEval({
        draftId,
        orgId,
        userId: null,
        kind: "should-trigger",
        prompt: "review this plan",
      });
      check("a golden task and a probe exist", task.ok && probe.ok);
      if (!task.ok || !probe.ok) throw new Error("could not create cases");

      /**
       * A matrix arm that would look like a broken case to Skill CI.
       *
       * Written directly: the without-arm failing is the arm working, and this is the exact row
       * that must not reach `evalStates`. First a passing CI run so the case has a real state,
       * then the arm on top of it.
       */
      await owner.query(
        `insert into eval_runs (org_id, eval_id, content_hash, verdict, model)
         values ($1, $2, $3, 'pass', 'probe')`,
        [orgId, task.id, hash],
      );
      await owner.query(
        `insert into eval_runs (org_id, eval_id, content_hash, verdict, model, with_skill)
         values ($1, $2, $3, 'fail', 'model-a', false)`,
        [orgId, task.id, hash],
      );

      const states = await evalStates({ draftId }, orgId);
      const golden = states.find((s) => s.id === task.id);
      check(
        "Skill CI still sees the passing run, not the without-arm failure",
        golden?.latest?.verdict === "pass",
        golden?.latest?.verdict ?? "none",
      );

      /*
       * Fill the remaining three cells so exactly one task is complete, then run the matrix with
       * mocks that are never reached — every cell already exists, so it must spend nothing.
       */
      for (const [model, withSkill, verdict] of [
        ["model-a", true, "pass"],
        ["model-b", false, "fail"],
        ["model-b", true, "pass"],
      ] as const) {
        await owner.query(
          `insert into eval_runs (org_id, eval_id, content_hash, verdict, model, with_skill)
           values ($1, $2, $3, $4, $5, $6)`,
          [orgId, task.id, hash, verdict, model, withSkill],
        );
      }

      const unreachable = {
        a: null as never,
        b: null as never,
        judge: null as never,
        aId: "model-a",
        bId: "model-b",
        judgeId: "judge",
      };
      const report = await runMatrixWithModels(
        { draftId, orgId, name: "n", description: "d", body: built.body },
        unreachable,
      );

      check(
        "a fully measured document re-runs nothing and spends nothing",
        report.costMicros === 0,
        "the mocks would have thrown had a cell been missing",
      );
      check(
        "the single task counts as complete",
        report.completeTasks === 1 && report.incompleteTasks === 0,
        `${report.completeTasks} complete`,
      );
      check(
        "both models improve from 0% to 100% on it",
        report.perModel.length === 2 &&
          report.perModel.every((row) => row.delta === 1),
        report.perModel.map((r) => `${r.model} ${formatDelta(r.delta)}`).join(", "),
      );
      check("one task is marked thin", report.thin);
      check(
        "and nothing was recorded, because the draft is not published",
        report.recorded === false,
      );

      /*
       * The probe is a trigger case, not a golden task. It must not appear in the matrix at all
       * — a matrix over a should-trigger probe has no expectation to judge against.
       */
      const onlyGolden = await owner.query<{ n: string }>(
        `select count(distinct eval_id)::text as n from eval_runs
          where content_hash = $1 and with_skill is not null`,
        [hash],
      );
      check(
        "trigger probes are not part of the matrix",
        onlyGolden.rows[0].n === "1",
        `${onlyGolden.rows[0].n} case measured`,
      );

      /*
       * Now break one cell. An incomplete task must drop out of the delta entirely rather than
       * contributing a one-sided rate — the failure this suite opens by reproducing.
       */
      const second = await createEval({
        draftId,
        orgId,
        userId: null,
        kind: "golden-task",
        prompt: "Second task",
        expectation: "Something",
      });
      if (second.ok) {
        await owner.query(
          `insert into eval_runs (org_id, eval_id, content_hash, verdict, model, with_skill)
           values ($1, $2, $3, 'pass', 'model-a', true)`,
          [orgId, second.id, hash],
        );
        const partial = await runMatrixWithModels(
          { draftId, orgId, name: "n", description: "d", body: built.body },
          unreachable,
        );
        check(
          "a task missing three cells is excluded rather than averaged in",
          partial.completeTasks === 1 && partial.incompleteTasks === 1,
          `${partial.completeTasks} complete, ${partial.incompleteTasks} excluded`,
        );
      }
    } finally {
      if (draftId) {
        await owner.query(`delete from skill_drafts where id = $1`, [draftId]);
      }
      await owner.end().catch(() => undefined);
    }
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
