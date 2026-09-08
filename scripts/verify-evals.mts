import "dotenv/config";

import { readFileSync } from "node:fs";

import { MockLanguageModelV4 } from "ai/test";
import { Client } from "pg";

import {
  EVAL_KIND_META,
  EVAL_KINDS,
  EVAL_VERDICTS,
  isRegression,
  isStale,
  MAX_CASES_PER_RUN,
  summarise,
  type EvalCaseState,
} from "../src/lib/evals";
import { MODEL_DEFAULTS, MODEL_TASKS } from "../src/lib/models";
import { rateFor } from "../src/lib/llm-pricing";

/**
 * Skill CI says a skill works, and says it only as strongly as the evidence (plan step D1).
 *
 *   pnpm verify:evals
 *
 * Free. The runner is driven with `ai/test` mocks, so no provider is reached; the rows it
 * writes are removed in a `finally`.
 *
 * ## What is actually at risk
 *
 * This is the first surface that claims a skill **works** rather than that it is well-formed,
 * and it gates publication. Four ways that goes wrong, all of them quiet:
 *
 *   1. **Blocking on any failure instead of on a regression.** An author who writes the case
 *      the skill does not satisfy yet — a specification — would be unable to publish at all,
 *      and would learn to delete cases rather than write them. The gate would then protect
 *      nothing.
 *   2. **A stale result gating a publish.** A verdict about an older document is not a verdict
 *      about this one, and treating it as one blocks a fix that already worked.
 *   3. **`error` counted as `fail`.** Our outage becomes the customer's quality regression.
 *   4. **A trigger probe that sees the body.** The description is all an agent matches on. A
 *      probe with the body would pass for skills whose description never fires — testing
 *      something no agent reads, and reporting the result as triggering precision.
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

const HASH_NOW = "a".repeat(64);
const HASH_OLD = "b".repeat(64);

function state(over: Partial<EvalCaseState> = {}): EvalCaseState {
  return {
    id: "case",
    kind: "golden-task",
    prompt: "p",
    expectation: "e",
    source: "authored",
    latest: null,
    previous: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
console.info("\nWhat blocks a publish, and what must not");
// ---------------------------------------------------------------------------------------

/**
 * The failure the regression rule exists to prevent, reproduced first.
 *
 * "Any failing case blocks publication" is the obvious rule and it is wrong. An aspirational
 * case — written to say what the skill should eventually do — has never passed, and failing is
 * its correct state. Under the naive rule the author cannot publish, learns that writing cases
 * costs them the ability to ship, and stops writing them.
 */
{
  const aspirational = state({
    latest: { verdict: "fail", detail: null, contentHash: HASH_NOW },
    previous: null,
  });
  const naiveWouldBlock = aspirational.latest?.verdict === "fail";
  check(
    "a naive any-failure rule would block a case that has never passed",
    naiveWouldBlock,
    "which is a specification, not a defect",
  );
  check(
    "the regression rule does not",
    !isRegression(aspirational),
  );

  const regressed = state({
    latest: { verdict: "fail", detail: null, contentHash: HASH_NOW },
    previous: { verdict: "pass", contentHash: HASH_OLD },
  });
  check(
    "and it does catch a case that used to pass",
    isRegression(regressed),
    "something the skill did, it no longer does",
  );

  /*
   * `error` on either side is not a regression. A refused call, a provider outage or an
   * unparseable answer says nothing about the skill — counted as a failure it would let our own
   * downtime block a customer's publish.
   */
  check(
    "an errored run is not a regression",
    !isRegression(
      state({
        latest: { verdict: "error", detail: null, contentHash: HASH_NOW },
        previous: { verdict: "pass", contentHash: HASH_OLD },
      }),
    ),
  );
  check(
    "and neither is a failure whose predecessor errored",
    !isRegression(
      state({
        latest: { verdict: "fail", detail: null, contentHash: HASH_NOW },
        previous: { verdict: "error", contentHash: HASH_OLD },
      }),
    ),
  );

  /*
   * Two runs against the *same* document are not a change. Without this, running twice on an
   * unedited draft could manufacture a regression out of a non-deterministic judge.
   */
  check(
    "two runs against the same document cannot be a regression",
    !isRegression(
      state({
        latest: { verdict: "fail", detail: null, contentHash: HASH_NOW },
        previous: { verdict: "pass", contentHash: HASH_NOW },
      }),
    ),
    "a flaky judge must not block a publish nobody changed anything for",
  );

  check(
    "a result about an older document is stale",
    isStale(state({ latest: { verdict: "pass", detail: null, contentHash: HASH_OLD } }), HASH_NOW),
  );
  check(
    "and a case that has never run is stale too, not passing",
    isStale(state(), HASH_NOW),
    "absence of evidence is not evidence",
  );

  const summary = summarise(
    [
      state({ id: "1", latest: { verdict: "pass", detail: null, contentHash: HASH_NOW } }),
      state({ id: "2", latest: { verdict: "fail", detail: null, contentHash: HASH_NOW } }),
      state({ id: "3", latest: { verdict: "error", detail: null, contentHash: HASH_NOW } }),
      state({ id: "4" }),
      state({ id: "5", latest: { verdict: "pass", detail: null, contentHash: HASH_OLD } }),
    ],
    HASH_NOW,
  );
  check(
    "the summary keeps passed, failed, errored, never-run and stale apart",
    summary.passed === 2 &&
      summary.failed === 1 &&
      summary.errored === 1 &&
      summary.neverRun === 1 &&
      summary.stale === 2,
    `${summary.passed}p ${summary.failed}f ${summary.errored}e ${summary.neverRun}n ${summary.stale}s`,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe vocabulary and the models");
// ---------------------------------------------------------------------------------------

check(
  "one probe model covers both trigger directions and golden tasks",
  EVAL_KINDS.length === 3 &&
    EVAL_KINDS.includes("should-trigger") &&
    EVAL_KINDS.includes("should-not-trigger") &&
    EVAL_KINDS.includes("golden-task"),
  "D2's trigger lab reads these rows rather than a parallel set",
);

check(
  "only a golden task needs an expectation",
  EVAL_KIND_META["golden-task"].needsExpectation &&
    !EVAL_KIND_META["should-trigger"].needsExpectation &&
    !EVAL_KIND_META["should-not-trigger"].needsExpectation,
);

check(
  "error is a verdict of its own, not a kind of failure",
  EVAL_VERDICTS.length === 3 && EVAL_VERDICTS.includes("error"),
  EVAL_VERDICTS.join(", "),
);

check(
  "the run loop has a fuse",
  MAX_CASES_PER_RUN > 0 && MAX_CASES_PER_RUN <= 50,
  `${MAX_CASES_PER_RUN} cases per run`,
);

for (const task of ["evalAgent", "evalJudge"] as const) {
  check(
    `${task} is a task with a default, like every other paid call`,
    MODEL_TASKS.includes(task) && Boolean(MODEL_DEFAULTS[task]),
    MODEL_DEFAULTS[task],
  );
  check(
    `and ${task}'s rate is in the price table`,
    rateFor(MODEL_DEFAULTS[task]).inputPerMTok !== rateFor("definitely/not-a-model").inputPerMTok,
    `$${rateFor(MODEL_DEFAULTS[task]).inputPerMTok}/MTok in`,
  );
}

/*
 * The judge must not be the producer. A model grading its own answer in one turn is not a
 * judge, and the two settings existing separately is what makes that structural rather than a
 * convention somebody can collapse later.
 */
{
  const runner = readFileSync("src/server/evals/run.ts", "utf8");
  check(
    "the golden-task producer and the judge are two calls",
    /models\.agent/.test(runner) && /models\.judge/.test(runner),
    "a model asked whether it did well says yes",
  );
  check(
    "both are resolved from settings, never from a constant",
    /modelFor\("evalAgent"\)/.test(runner) &&
      /modelFor\("evalJudge"\)/.test(runner) &&
      !/anthropic\/|google\/|openai\//.test(runner),
  );
  check(
    "verdicts are produced at temperature zero, so a re-run reproduces",
    (runner.match(/temperature: 0,/g) ?? []).length >= 2,
  );

  /**
   * The trigger probe sees the description and never the body.
   *
   * This is the check that makes a trigger result mean anything. An agent selects on the
   * description alone, so a probe that saw the body would pass for skills whose description
   * never fires — and it would report that as triggering precision, which is a confident wrong
   * answer of exactly the `quality_score` banding kind.
   */
  const triggerFn = runner.slice(
    runner.indexOf("async function runTrigger"),
    runner.indexOf("async function runGolden"),
  );
  check(
    "a trigger probe is handed the description and never the body",
    triggerFn.length > 0 &&
      /input\.description/.test(triggerFn) &&
      !/input\.body/.test(triggerFn),
    "the description is all an agent matches on",
  );
  check(
    "while a golden task is handed the whole document",
    /input\.body/.test(runner.slice(runner.indexOf("async function runGolden"))),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe publish gate, end to end");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("gate checks", "no database connection — the checks above are complete without it");
}

let draftId: string | null = null;

if (connected) {
  const tables = await owner.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables
      where table_schema = 'public' and table_name in ('skill_evals','eval_runs')`,
  );
  const orgId = (await owner.query<{ id: string }>(`select id from organization limit 1`)).rows[0]
    ?.id;

  if (tables.rows[0].n !== "2") {
    skip("gate checks", "the eval tables do not exist — apply migrations/0034");
  } else if (!orgId) {
    skip("gate checks", "no organisation exists — sign up once, then re-run");
  } else {
    try {
      const { createForTest } = await import("../src/server/builder/drafts");
      const { setDraftBlocks } = await import("../src/server/builder/blocks");
      const { createEval, evalStates, contentHashOf } = await import("../src/server/evals/store");
      const { runEvalsWithModels } = await import("../src/server/evals/run");
      const { publishForTest } = await import("../src/server/builder/publish");

      const userId =
        (await owner.query<{ id: string }>(`select id from "user" limit 1`)).rows[0]?.id ?? null;

      draftId = await createForTest(
        {
          name: `verify-evals-${Date.now()}`,
          purpose: "Probe the eval gate. Removed at the end of this run.",
          context: null,
          category: "review",
          domain: null,
          dialect: "anthropic_skill",
          sectionInputs: {},
          scaffoldSections: [],
        },
        orgId,
        userId,
      );

      /*
       * Frontmatter first, then blocks.
       *
       * `setDraftBlocks` validates the render it produces, and it reads the name and
       * description off the draft to do it. Without them structural-lint raises
       * `missing-description` at high severity, `validation.blocked` goes true, and **publish is
       * refused by the R4.5 gate before the eval gate is ever consulted** — which is how the
       * first version of this suite "tested" the regression gate while never reaching it.
       */
      await owner.query(
        `update skill_drafts
            set summary = $2,
                frontmatter = jsonb_build_object('name', $3::text, 'description', $2::text)
          where id = $1`,
        [
          draftId,
          "Review a terraform plan before it is applied. Use when a plan needs checking for destructive changes.",
          "terraform-plan-review",
        ],
      );

      const first = await setDraftBlocks(
        draftId,
        orgId,
        [
          { form: "heading", depth: 2, type: null, text: "Steps" },
          {
            form: "content",
            depth: null,
            type: "procedure",
            text: "1. Read the plan output in full.\n2. Flag every destroy of a stateful resource.",
          },
        ],
        { reason: "edited" },
      );

      /*
       * The precondition, asserted rather than assumed. A suite whose subject is the eval gate
       * must fail loudly when the draft cannot reach it, or every assertion below is about the
       * validation gate wearing the eval gate's name.
       */
      check(
        "the draft clears the R4.5 validation gate, so the eval gate is reachable",
        first.validation.blocked === false,
        first.validation.blocked
          ? first.validation.findings.map((f) => f.reason).join(", ")
          : `${first.validation.findings.length} non-blocking finding(s)`,
      );

      /*
       * The parent constraint, attempted rather than assumed. Clean data says nothing about
       * whether a case can end up in two places or in none — the same reasoning `verify:dedup`
       * uses when it tries the insert that caused the bug.
       */
      for (const [label, values] of [
        ["both parents", `$1, $2, (select id from skills limit 1)`],
        ["neither parent", `$1, null, null`],
      ] as const) {
        const refused = await owner
          .query(
            `insert into skill_evals (org_id, draft_id, skill_id, kind, prompt)
             values (${values.replace("$2", "$2::uuid")}, 'should-trigger', 'x')`,
            values.includes("$2") ? [orgId, draftId] : [orgId],
          )
          .then(
            () => false,
            () => true,
          );
        check(`a case with ${label} is refused by the database`, refused);
      }

      const caseA = await createEval({
        draftId,
        orgId,
        userId,
        kind: "should-trigger",
        prompt: "Review this terraform plan before I apply it",
      });
      const caseB = await createEval({
        draftId,
        orgId,
        userId,
        kind: "should-not-trigger",
        prompt: "Book me a flight to Lisbon",
      });
      check("cases are created", caseA.ok && caseB.ok);
      if (!caseA.ok || !caseB.ok) throw new Error("could not create cases");

      // ---- the runner, with mocks ----

      /*
       * `doGenerate` takes a result object as well as a function, and the object form is what
       * types cleanly — the function form widens `finishReason` to `string` because the union
       * gives the async return no contextual type.
       *
       * The same mock answers both the trigger probe and the golden-task judge, which is the
       * point of the asymmetry check below: one answer, two directions, two verdicts.
       */
      const judge = (wouldFire: boolean) =>
        new MockLanguageModelV4({
          doGenerate: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ wouldFire, confidence: 90, why: "probe" }),
              },
            ],
            /* An object, not a string — the spec's shape, so the fixture stays faithful. */
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 40, text: 40, reasoning: 0 },
            },
            warnings: [],
          },
        });

      const ran = await runEvalsWithModels(
        {
          draftId,
          orgId,
          name: "terraform-plan-review",
          description: "Review a terraform plan before apply. Use when a plan needs checking.",
          body: first.body,
        },
        {
          agent: judge(true),
          judge: judge(true),
          agentId: MODEL_DEFAULTS.evalAgent,
          judgeId: MODEL_DEFAULTS.evalJudge,
        },
      );
      /*
       * The mock answers "would fire" to both probes, so the should-trigger case passes and the
       * should-not-trigger case fails. That asymmetry is the check: a runner that ignored the
       * case's direction would score both the same.
       */
      check(
        "a probe is scored against its own direction, not against the model's answer",
        ran.ran === 2 && ran.passed === 1 && ran.failed === 1,
        `${ran.passed} passed, ${ran.failed} failed from one answer`,
      );
      check("and the run is metered", ran.costMicros > 0, `${ran.costMicros} micros`);

      const afterRun = await evalStates({ draftId }, orgId);
      check(
        "each case now has a result stamped with the document it judged",
        afterRun.every((c) => c.latest?.contentHash === contentHashOf(first.body)),
      );

      /*
       * Re-running without editing must do nothing. The selector skips cases already judged
       * against these exact bytes — spending money to re-learn an answer already on screen is
       * the thing a "run" button invites.
       */
      const again = await runEvalsWithModels(
        {
          draftId,
          orgId,
          name: "terraform-plan-review",
          description: "Review a terraform plan before apply. Use when a plan needs checking.",
          body: first.body,
        },
        {
          agent: judge(true),
          judge: judge(true),
          agentId: MODEL_DEFAULTS.evalAgent,
          judgeId: MODEL_DEFAULTS.evalJudge,
        },
      );
      check(
        "re-running an unedited draft runs nothing and spends nothing",
        again.ran === 0 && again.costMicros === 0,
        `${again.ran} run`,
      );

      // ---- the gate ----

      /*
       * Edit the draft, then answer the other way: the should-trigger case that passed now
       * fails against a different document. That is a regression by construction, and it is the
       * only shape that may block a publish.
       */
      const second = await setDraftBlocks(
        draftId,
        orgId,
        [
          { form: "heading", depth: 2, type: null, text: "Steps" },
          {
            form: "content",
            depth: null,
            type: "procedure",
            text: "1. Read the plan output in full.\n2. Flag every destroy of a stateful resource.",
          },
          {
            form: "content",
            depth: null,
            type: "guardrail",
            text: "Never approve a plan that destroys a stateful resource.",
          },
        ],
        { reason: "edited" },
      );
      await runEvalsWithModels(
        {
          draftId,
          orgId,
          name: "terraform-plan-review",
          description: "Something vague that no longer says when to use it.",
          body: second.body,
        },
        {
          agent: judge(false),
          judge: judge(false),
          agentId: MODEL_DEFAULTS.evalAgent,
          judgeId: MODEL_DEFAULTS.evalJudge,
        },
      );

      const regressed = (await evalStates({ draftId }, orgId)).filter(isRegression);
      check(
        "editing the draft into a failure produces a regression",
        regressed.length === 1 && regressed[0].kind === "should-trigger",
        `${regressed.length} regression(s)`,
      );

      const blocked = await publishForTest(draftId, orgId, userId ?? "unknown");
      check(
        "and publishing is refused, naming the case",
        !blocked.ok && /used to pass/i.test(blocked.message),
        blocked.ok ? "published anyway" : blocked.message.slice(0, 70),
      );

      /*
       * Remove the regressed case and the publish goes through. Proving the gate can be
       * cleared matters as much as proving it blocks — a gate that never opens is
       * indistinguishable from a broken publish, and the author would have no way to tell.
       */
      const { deleteEval } = await import("../src/server/evals/store");
      await deleteEval(regressed[0].id, orgId);

      const published = await publishForTest(draftId, orgId, userId ?? "unknown");
      check(
        "removing the regression lets the publish through",
        published.ok,
        published.ok ? published.slug : published.message.slice(0, 70),
      );

      if (published.ok) {
        const repointed = await owner.query<{ n: string }>(
          `select count(*)::text as n from skill_evals
            where skill_id = $1 and draft_id is null`,
          [published.skillId],
        );
        check(
          "and the surviving cases moved onto the skill they now describe",
          repointed.rows[0].n === "1",
          `${repointed.rows[0].n} case(s) re-pointed`,
        );
      }
    } finally {
      if (draftId) {
        /*
         * `llm_usage.subject_id` is text and `skill_evals.id` is uuid, so the subquery needs a
         * cast — Postgres has no `text = uuid` operator and the first version of this cleanup
         * died on it *after* the assertions, leaving rows behind. A cleanup that only runs when
         * everything passed is not a cleanup.
         */
        await owner.query(
          `delete from llm_usage
            where subject_type = 'skill_evals'
              and subject_id in (
                select id::text from skill_evals where draft_id = $1
              )`,
          [draftId],
        );
        /*
         * Any skill this draft became, whether or not the publish assertion passed. Looked up
         * rather than remembered, because the failure mode being cleaned up after is precisely
         * the one where the variable holding it was never set.
         */
        await owner.query(
          `delete from skills where id in (
             select published_skill_id from skill_drafts
              where id = $1 and published_skill_id is not null
           )`,
          [draftId],
        );
        await owner.query(`delete from skill_drafts where id = $1`, [draftId]);
        /*
         * The builder source each org gets is created by `publishDraft` and is not ours to
         * remove. Ledger rows go through the owner connection because `llm_usage` has no DELETE
         * policy — the lesson `verify:spend` paid for by spending the real platform budget and
         * then being unable to clean up.
         */
      }
      await owner.end().catch(() => undefined);
    }
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
