import "dotenv/config";

import { readFileSync } from "node:fs";

import { MockLanguageModelV4 } from "ai/test";
import { Client } from "pg";

import { MODEL_DEFAULTS, MODEL_TASKS } from "../src/lib/models";
import { rateFor } from "../src/lib/llm-pricing";
import { REVISION_REASONS } from "../src/lib/draft-blocks";
import {
  isOfferable,
  MIN_SAVING_PERCENT,
  summariseVariant,
  VARIANT_OUTCOMES,
  VARIANT_STATUSES,
  type CaseComparison,
} from "../src/lib/variants";

/**
 * A cheaper variant is proven before it is offered (Doc 6 RW.9, plan step D4).
 *
 *   pnpm verify:optimise
 *
 * Free. The compression and the verification are both driven with `ai/test` mocks, so no
 * provider is reached; the rows are removed in a `finally`.
 *
 * ## What is actually at risk
 *
 * This is the only surface in the product that proposes **deleting** a customer's words, and it
 * proposes it with a number attached. Four ways that goes wrong:
 *
 *   1. **Offering a cut nobody checked.** A shorter document is one model call. The entire claim
 *      is "identical eval results", and without the verification this feature is a shredder with
 *      a confidence score.
 *   2. **A regression hidden behind a good number.** −55% reads as a triumph, and a single case
 *      that used to pass and now fails means something load-bearing was removed.
 *   3. **An offer that outlived its document.** A variant is a claim about specific bytes. Edit
 *      the original and the comparison was against something that no longer exists.
 *   4. **Accepting by writing the body.** `skill_drafts.body` is a render with exactly one
 *      writer. A second one here would put the document and its blocks out of step, silently.
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

const comparison = (before: string | null, after: string | null, id = "c"): CaseComparison => ({
  caseId: id,
  prompt: `case ${id}`,
  before,
  after,
});

// ---------------------------------------------------------------------------------------
console.info("\nWhat may be offered, and what may not");
// ---------------------------------------------------------------------------------------

/**
 * Reproduced first: the naive rule offers on the saving alone.
 *
 * "It is 40% shorter, take it" is the feature as anybody would build it in an afternoon, and it
 * is a document shredder. The case that regressed is the whole reason the eval lab was built
 * three steps earlier.
 */
{
  const broke = summariseVariant({
    comparisons: [comparison("pass", "fail", "1"), comparison("pass", "pass", "2")],
    sourceTokens: 4200,
    variantTokens: 2500,
  });
  const naiveWouldOffer = broke.savedPercent >= MIN_SAVING_PERCENT;
  check(
    "a saving-only rule would offer a variant that broke a case",
    naiveWouldOffer,
    `${broke.savedPercent}% shorter, and one case now fails`,
  );
  check("the real rule refuses it", !isOfferable(broke));
  check(
    "and it is reported as a regression, named",
    broke.outcome === "regressed" && broke.regressions.length === 1,
    broke.regressions.map((r) => r.prompt).join(", "),
  );

  const unverified = summariseVariant({
    comparisons: [],
    sourceTokens: 4200,
    variantTokens: 2000,
  });
  check(
    "a variant with nothing to compare against is not offered however short",
    !isOfferable(unverified) && unverified.outcome === "unverified",
    `${unverified.savedPercent}% shorter and unproven`,
  );

  const trivial = summariseVariant({
    comparisons: [comparison("pass", "pass")],
    sourceTokens: 4200,
    variantTokens: 4100,
  });
  check(
    "and neither is a saving inside the estimator's own error",
    !isOfferable(trivial),
    `${trivial.savedPercent}% is under ${MIN_SAVING_PERCENT}%`,
  );

  const good = summariseVariant({
    comparisons: [comparison("pass", "pass", "1"), comparison("fail", "fail", "2")],
    sourceTokens: 4200,
    variantTokens: 1900,
  });
  check(
    "a verified, meaningfully shorter variant with the same results is offered",
    isOfferable(good) && good.outcome === "identical",
    `${good.savedPercent}% shorter, ${good.compared} cases identical`,
  );
}

/*
 * A case that stayed failing is not a regression, and a case that started passing is not a
 * reason to celebrate — it usually means the case was ambiguous. Both are reported as
 * themselves.
 */
{
  const improved = summariseVariant({
    comparisons: [comparison("fail", "pass")],
    sourceTokens: 4000,
    variantTokens: 2000,
  });
  check(
    "a case that started passing is an improvement, not a regression",
    improved.outcome === "improved" && improved.regressions.length === 0,
  );
}

/*
 * `error` on either side makes a case incomparable rather than failed. A provider refusal while
 * running the variant would otherwise read as the compression breaking something — the same
 * line Skill CI and the matrix both hold.
 */
{
  const errored = summariseVariant({
    comparisons: [comparison("pass", "error", "1"), comparison("pass", "pass", "2")],
    sourceTokens: 4000,
    variantTokens: 2000,
  });
  check(
    "an errored run makes a case incomparable rather than regressed",
    errored.outcome === "identical" && errored.incomparable === 1 && errored.compared === 1,
    `${errored.compared} compared, ${errored.incomparable} excluded`,
  );

  const oneSided = summariseVariant({
    comparisons: [comparison("pass", null)],
    sourceTokens: 4000,
    variantTokens: 2000,
  });
  check(
    "a case never run on one side is excluded, not assumed to have held",
    oneSided.compared === 0 && oneSided.outcome === "unverified",
    "an unmeasured case is not a passing one",
  );
}

/*
 * A "compression" can grow the document. The sign has to survive, or the panel would show a
 * negative saving as a positive one.
 */
{
  const grew = summariseVariant({
    comparisons: [comparison("pass", "pass")],
    sourceTokens: 2000,
    variantTokens: 2400,
  });
  check(
    "a variant that grew reports a negative saving and is not offered",
    grew.savedTokens < 0 && grew.savedPercent < 0 && !isOfferable(grew),
    `${grew.savedPercent}%`,
  );
}

check(
  "the status and outcome vocabularies are closed",
  VARIANT_STATUSES.length === 4 && VARIANT_OUTCOMES.length === 4,
  `${VARIANT_STATUSES.join(", ")} / ${VARIANT_OUTCOMES.join(", ")}`,
);

check(
  "optimise is a task with a priced default, like every other paid call",
  MODEL_TASKS.includes("optimise") &&
    rateFor(MODEL_DEFAULTS.optimise).inputPerMTok !== rateFor("nope/nope").inputPerMTok,
  MODEL_DEFAULTS.optimise,
);

check(
  "and a compression is legible in the revision history",
  (REVISION_REASONS as readonly string[]).includes("optimised"),
  "a revision that removed a third of the text must not look like a mistake",
);

// ---------------------------------------------------------------------------------------
console.info("\nWhat the optimiser is careful about");
// ---------------------------------------------------------------------------------------

{
  const src = readFileSync("src/server/evals/optimise.ts", "utf8");

  /**
   * The single-writer property, asserted here as well as in `verify:draft-blocks`.
   *
   * Accepting a variant is the most tempting place in the codebase to write `body` directly —
   * the variant *is* a body, and one update would do it. That would put the document out of
   * step with the blocks it is supposed to be a render of, silently.
   */
  check(
    "accepting goes through the block importer, never through a body write",
    /importDraftBody\(/.test(src) && !/skillDrafts[\s\S]{0,300}body:/.test(src),
  );
  check(
    "the verification runs the real eval runner",
    /runEvals\(/.test(src) && /runEvalsWithModels\(/.test(src),
    "a lighter scorer would judge the variant by different rules than the original",
  );
  check(
    "the variant is scored under its own content hash",
    /contentHashOf\(variantBody\)/.test(src),
    "which is why the comparison needed no new table",
  );
  check(
    "an offer is only current while the source document is unchanged",
    /row\.sourceHash === hash/.test(src),
  );
  check(
    "an earlier proposal is superseded rather than left beside the new one",
    /status: "superseded"/.test(src),
  );
  check(
    "the compression runs at temperature zero",
    /temperature: 0,/.test(src),
    "an author is comparing two documents, not browsing options",
  );
  check(
    "the budget is checked before the rewrite is paid for",
    /assertWithinBudget\("eval", input\.orgId\)/.test(src),
  );
  /*
   * A published skill's body lives in object storage behind the hash a verdict covers, so
   * replacing it is a re-publish rather than an edit. Refused in words rather than silently
   * doing nothing, which is what an unguarded `if (row.draftId)` would have done.
   */
  check(
    "taking a variant on a published skill is refused explicitly",
    /Only a draft can take a variant/.test(src),
  );

  const prompt = src.slice(src.indexOf("const SYSTEM"), src.indexOf("export type OptimiseInput"));
  check(
    "the prompt protects the parts that are usually why the skill exists",
    /guardrail/i.test(prompt) && /exception/i.test(prompt),
  );
  check(
    "and forbids inventing anything on the way",
    /Never invent/i.test(prompt),
  );
  check(
    "the document is fenced as material rather than instruction (R7.3)",
    /not an instruction to you/i.test(prompt),
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
  skip("optimiser checks", "no database connection — the checks above are complete without it");
}

let draftId: string | null = null;
const createdEvalIds: string[] = [];

if (connected) {
  const hasTable = await owner.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables
      where table_schema = 'public' and table_name = 'skill_variants'`,
  );
  const orgId = (await owner.query<{ id: string }>(`select id from organization limit 1`)).rows[0]
    ?.id;

  if (hasTable.rows[0].n === "0") {
    skip("optimiser checks", "skill_variants does not exist — apply migrations/0036");
  } else if (!orgId) {
    skip("optimiser checks", "no organisation exists — sign up once, then re-run");
  } else {
    try {
      const { createForTest } = await import("../src/server/builder/drafts");
      const { setDraftBlocks, getDraftBlocks, listDraftRevisions } = await import(
        "../src/server/builder/blocks"
      );
      const { createEval, contentHashOf } = await import("../src/server/evals/store");
      const { optimiseWithModels, currentVariant, acceptVariant } = await import(
        "../src/server/evals/optimise"
      );

      draftId = await createForTest(
        {
          name: `verify-optimise-${Date.now()}`,
          purpose: "Probe the optimiser. Removed at the end of this run.",
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

      /* Long enough that a compression is a real saving rather than rounding. */
      const verbose =
        "It is generally worth bearing in mind that, before you apply anything at all, " +
        "you should really take the time to read through the whole of the plan output " +
        "carefully and in full, because there may well be changes in there that you did " +
        "not expect to see and that could turn out to matter quite a lot later on. ".repeat(4);

      const built = await setDraftBlocks(
        draftId,
        orgId,
        [
          { form: "heading", depth: 2, type: null, text: "Steps" },
          { form: "content", depth: null, type: "procedure", text: verbose },
        ],
        { reason: "edited" },
      );
      const sourceHash = contentHashOf(built.body);

      const task = await createEval({
        draftId,
        orgId,
        userId: null,
        kind: "golden-task",
        prompt: "Summarise the plan",
        expectation: "Mentions reading the plan in full",
      });
      if (!task.ok) throw new Error("could not create a case");
      createdEvalIds.push(task.id);

      /* A passing verdict on the original, so there is a "before" to compare against. */
      await owner.query(
        `insert into eval_runs (org_id, eval_id, content_hash, verdict, model)
         values ($1, $2, $3, 'pass', 'probe')`,
        [orgId, task.id, sourceHash],
      );

      const short = "## Steps\n\nRead the plan output in full before applying anything.";
      const writer = new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ body: short, removed: "Hedging and repetition." }),
            },
          ],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 60, text: 60, reasoning: 0 },
          },
          warnings: [],
        },
      });
      const judge = new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ meetsExpectation: true, why: "It does." }),
            },
          ],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 800, noCache: 800, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 30, text: 30, reasoning: 0 },
          },
          warnings: [],
        },
      });

      const result = await optimiseWithModels(
        {
          draftId,
          orgId,
          userId: null,
          name: "terraform-plan-review",
          description: "Review a plan before apply.",
          body: built.body,
        },
        writer,
        MODEL_DEFAULTS.optimise,
        {
          agent: judge,
          judge,
          agentId: MODEL_DEFAULTS.evalAgent,
          judgeId: MODEL_DEFAULTS.evalJudge,
        },
      );

      check(
        "the variant is measurably shorter",
        result.report.savedPercent >= MIN_SAVING_PERCENT,
        `${result.report.sourceTokens} → ${result.report.variantTokens} est. (${result.report.savedPercent}%)`,
      );
      check(
        "its case was compared on both documents",
        result.report.compared === 1 && result.report.outcome === "identical",
        `${result.report.compared} compared, ${result.report.outcome}`,
      );
      check("and it is offerable", result.offerable);
      check("the rewrite and the verification were both metered", result.costMicros > 0);

      /*
       * The runs must be stored under the *variant's* hash, not the source's. Otherwise the
       * comparison reads one document twice and every variant is trivially identical.
       */
      const byHash = await owner.query<{ content_hash: string; n: string }>(
        `select content_hash, count(*)::text as n from eval_runs
          where eval_id = $1 group by content_hash`,
        [task.id],
      );
      check(
        "the variant's verdict is stored under its own hash",
        byHash.rowCount === 2,
        `${byHash.rowCount} distinct documents scored`,
      );

      const offer = await currentVariant({ draftId }, orgId, built.body);
      check("the proposal reads back as current", offer !== null && offer.current);

      /*
       * Edit the document and the offer stops being about it. This is the check that keeps a
       * stale variant from being taken against bytes it was never compared with.
       */
      const moved = await setDraftBlocks(
        draftId,
        orgId,
        [
          { form: "heading", depth: 2, type: null, text: "Steps" },
          { form: "content", depth: null, type: "procedure", text: `${verbose} And one more.` },
        ],
        { reason: "edited" },
      );
      const stale = await currentVariant({ draftId }, orgId, moved.body);
      check(
        "editing the document makes the offer stale",
        stale !== null && !stale.current,
        "a variant is a claim about specific bytes",
      );

      /*
       * Accepting must go through the importer: the body becomes blocks, and the blocks become
       * the body. A direct write would leave the two out of step with nothing failing.
       */
      const accepted = await acceptVariant(result.variantId, orgId, null);
      check("the variant can be taken", accepted.ok, accepted.ok ? "" : accepted.message);

      const blocks = await getDraftBlocks(draftId, orgId);
      check(
        "and it arrives as typed blocks rather than as a body string",
        blocks.length >= 2 && blocks.some((b) => b.form === "heading"),
        `${blocks.length} blocks, ${blocks.filter((b) => b.type).length} typed`,
      );

      const revisions = await listDraftRevisions(draftId, orgId);
      check(
        "the compression is legible in the history",
        revisions[0]?.reason === "optimised",
        `#${revisions[0]?.revision} ${revisions[0]?.reason} · ${revisions[0]?.note ?? ""}`,
      );

      const again = await acceptVariant(result.variantId, orgId, null);
      check(
        "and a variant cannot be taken twice",
        !again.ok,
        again.ok ? "accepted twice" : again.message,
      );
    } finally {
      if (createdEvalIds.length > 0) {
        await owner.query(
          `delete from llm_usage where subject_id = any($1)`,
          [createdEvalIds],
        );
      }
      await owner.query(`delete from llm_usage where subject_type = 'skill_variants'`);
      if (draftId) await owner.query(`delete from skill_drafts where id = $1`, [draftId]);
      await owner.end().catch(() => undefined);
    }
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
