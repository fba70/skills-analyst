import "dotenv/config";

import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  asPercent,
  COLLISION_NEIGHBOURS,
  isThin,
  MIN_PROBES_PER_DIRECTION,
  precision,
  recall,
  type ConfusionCounts,
} from "../src/lib/trigger";

/**
 * The trigger lab reports rates only as strongly as the probes behind them (plan step D2).
 *
 *   pnpm verify:trigger
 *
 * Free by default. The arithmetic half needs nothing and the lab half reads stored runs.
 *
 *   pnpm verify:trigger --live
 *
 * adds one round trip through the collision path, which **costs money** — a handful of
 * embeddings, a fraction of a cent. Opt-in rather than default for the reason every free suite
 * here is free: a check you have to think about before running is a check that stops being run.
 * It exists at all because the alternative is shipping a path nobody has executed, and this
 * codebase already records what that costs — an index that has never answered a query is an
 * index nobody knows is wrong.
 *
 * ## What is actually at risk
 *
 * Not the division. Four ways a rate lies, and every one of them renders as a confident
 * percentage:
 *
 *   1. **Zero rendered as a measurement.** A skill with no should-trigger probes has *unknown*
 *      recall. Shown as 0% it tells the author their skill never fires, when the truth is that
 *      nobody has asked — the same class of mistake as `archetypes --blocks` printing eleven
 *      rows of zeros at 1% coverage.
 *   2. **Precision of 100% for a skill that never fires.** Nothing fired means nothing to be
 *      precise about. Reported as perfect it rewards exactly the failure it exists to catch.
 *   3. **A rate mixing verdicts from three different drafts.** A stale run is a fact about an
 *      older document, and folding it in produces a number about no document at all.
 *   4. **An `error` counted in either column.** Our outage moves a rate the author is being
 *      asked to act on.
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

const counts = (over: Partial<ConfusionCounts> = {}): ConfusionCounts => ({
  truePositive: 0,
  falseNegative: 0,
  trueNegative: 0,
  falsePositive: 0,
  ...over,
});

// ---------------------------------------------------------------------------------------
console.info("\nThe two rates, and what they refuse to say");
// ---------------------------------------------------------------------------------------

/**
 * The failure reproduced first: the naive arithmetic answers where it should decline.
 *
 * `TP / (TP + FN)` with both terms zero is `0/0`. In JavaScript that is `NaN`, and the obvious
 * repair — a `|| 0` — turns "nobody has measured this" into "this never fires". The repair is
 * the bug, and it is invisible: 0% is a perfectly plausible recall.
 */
{
  const nothing = counts();
  const naiveRecall = nothing.truePositive / (nothing.truePositive + nothing.falseNegative) || 0;
  check(
    "the naive rate turns an unmeasured skill into a 0% one",
    naiveRecall === 0,
    "0/0 is NaN, and `|| 0` reads as 'never fires'",
  );
  check("recall declines instead", recall(nothing) === null);

  /*
   * The mirror image, and the more dangerous of the two: a skill that fires on nothing has
   * *undefined* precision. Reported as 1 it scores perfectly on the axis it fails hardest.
   */
  const silent = counts({ falseNegative: 4, trueNegative: 4 });
  const naivePrecision =
    silent.truePositive / (silent.truePositive + silent.falsePositive) || 1;
  check(
    "and the naive precision gives a skill that never fires a perfect score",
    naivePrecision === 1,
  );
  check("precision declines instead", precision(silent) === null);

  check(
    "a null rate stays null all the way to the screen",
    asPercent(null) === null && asPercent(0.63) === "63%",
  );
}

{
  const good = counts({ truePositive: 8, falseNegative: 2, trueNegative: 9, falsePositive: 1 });
  check(
    "recall is right when there is something to measure",
    recall(good) === 0.8,
    `${asPercent(recall(good))}`,
  );
  check(
    "precision counts a wrong fire against it, not a missed one",
    precision(good) === 8 / 9,
    `${asPercent(precision(good))} — the 2 misses do not enter precision`,
  );
  check("and a full probe set is not marked thin", !isThin(good));
}

/*
 * Thin is per direction, not overall. Twenty should-fire probes and one should-not-fire probe
 * is a precision figure resting on a single case, and an overall count would call that healthy.
 */
check(
  "thinness is judged per direction",
  isThin(counts({ truePositive: 20, falseNegative: 0, trueNegative: 1, falsePositive: 0 })),
  `${MIN_PROBES_PER_DIRECTION} per direction, not ${MIN_PROBES_PER_DIRECTION} in total`,
);

check(
  "the neighbour list is short enough to read",
  COLLISION_NEIGHBOURS > 0 && COLLISION_NEIGHBOURS <= 10,
  `${COLLISION_NEIGHBOURS} neighbours per probe`,
);

// ---------------------------------------------------------------------------------------
console.info("\nWhat the lab counts, and what it leaves out");
// ---------------------------------------------------------------------------------------

/**
 * Source-tree assertions, because these are properties of the code that clean data cannot show.
 *
 * A rate built from stale or errored runs looks exactly like a rate built correctly — that is
 * the entire problem with it.
 */
{
  const lab = readFileSync("src/server/evals/trigger.ts", "utf8");
  check(
    "only runs against the current document count towards a rate",
    /state\.latest\?\.contentHash === hash/.test(lab),
    "a rate mixing three drafts is a rate about no document",
  );
  check(
    "an errored run is dropped from both columns rather than counted",
    /verdict === "error"\) continue/.test(lab),
  );
  check(
    "stale and never-run probes are reported separately, not folded in",
    /staleProbes/.test(lab) && /unrunProbes/.test(lab),
  );

  /*
   * The collision half must be able to say "nobody looked". An empty array and a null mean
   * opposite things and would render identically as "no collisions" — the distinction
   * `blockDeviations` had to draw between `notMeasured` and "nothing missing".
   */
  check(
    "collisions default to null, so 'not checked' is distinguishable from 'none found'",
    /collisions: null/.test(lab),
  );
  check(
    "no index means no answer and no charge",
    /embeddedCount === 0\) return \[\]/.test(lab),
    "embedding probes against an empty corpus bills for an unanswerable question",
  );
  /*
   * Strictly nearer. A tie is not a loss, and counting ties would make every probe contested in
   * a dense category — which is most of them.
   */
  check(
    "only a strictly nearer neighbour is a collision",
    /hit\.similarity > ownSimilarity/.test(lab),
  );
  /*
   * One batch for the description and every probe. Not only cheaper: it is the only way the
   * two sides of the comparison are guaranteed to come from the same model at the same moment.
   */
  /*
   * One call, holding the description and every probe. Matched on the *count* and the contents
   * rather than on the exact formatting — the first version pinned the call's line breaks and
   * went red the moment a second argument was added, which teaches people to edit checks.
   */
  check(
    "the description and the probes are embedded in one call",
    (lab.match(/embedBatch\(/g) ?? []).length === 1 &&
      /\$\{input\.name\}/.test(lab) &&
      /\.\.\.prompts/.test(lab),
  );
  check(
    "cosine is computed rather than assuming unit vectors",
    /Math\.sqrt\(normA\) \* Math\.sqrt\(normB\)/.test(lab),
    "a dot product that stopped being cosine would move every number here silently",
  );
}

/**
 * A customer-initiated embedding bills the customer, not the platform.
 *
 * `embedBatch` hard-coded `corpus_embedding` and a null org, which is right for the backfill and
 * wrong for anything a person sets off. RC.2 keeps two budgets so that "a busy month of
 * authoring must not halt corpus analysis" — and B3's similarity check had been charging the
 * platform since it shipped, with the collision lab about to do the same once per probe.
 *
 * Asserted against the source tree because the symptom is a row in the wrong column: everything
 * works, the numbers are right, and the only sign is the platform budget draining faster than
 * the backfill explains.
 */
{
  const embeddings = readFileSync("src/server/analytics/embeddings.ts", "utf8");
  check(
    "embedBatch takes a scope rather than hard-coding the platform budget",
    /scope: EmbedScope = PLATFORM_EMBED_SCOPE/.test(embeddings) &&
      /assertWithinBudget\(scope\.purpose, scope\.orgId\)/.test(embeddings),
  );
  check(
    "and the ledger row is written against that same scope",
    /purpose: scope\.purpose/.test(embeddings) && /orgId: scope\.orgId/.test(embeddings),
    "checking one budget and billing another is how a cap becomes unreachable",
  );

  const lab = readFileSync("src/server/evals/trigger.ts", "utf8");
  check(
    "the collision lab charges the workspace that asked",
    /purpose: "eval", orgId: input\.orgId/.test(lab),
  );

  const actions = readFileSync("src/app/(protected)/build/actions.ts", "utf8");
  check(
    "and so does the author similarity check, which had it backwards since B3",
    /scope: orgId \? \{ purpose: "builder", orgId \} : undefined/.test(actions),
  );
}

/**
 * D2 owns no probes. That was the reason for building D1 first, and it is worth asserting
 * rather than trusting — a second probe table is the thing the plan explicitly avoided.
 */
{
  const lab = readFileSync("src/server/evals/trigger.ts", "utf8");
  check(
    "the lab reads Skill CI's rows and defines no probe store of its own",
    /evalStates\(/.test(lab) && !/pgTable|CREATE TABLE/.test(lab),
    "should-trigger cases and trigger probes are one concept",
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
  skip("lab checks", "no database connection — the checks above are complete without it");
}

let draftId: string | null = null;

if (connected) {
  const orgId = (await owner.query<{ id: string }>(`select id from organization limit 1`)).rows[0]
    ?.id;
  const tables = await owner.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables
      where table_schema = 'public' and table_name in ('skill_evals','eval_runs')`,
  );

  if (tables.rows[0].n !== "2") {
    skip("lab checks", "the eval tables do not exist — apply migrations/0034");
  } else if (!orgId) {
    skip("lab checks", "no organisation exists — sign up once, then re-run");
  } else {
    try {
      const { createForTest } = await import("../src/server/builder/drafts");
      const { setDraftBlocks } = await import("../src/server/builder/blocks");
      const { createEval, contentHashOf } = await import("../src/server/evals/store");
      const { triggerReport } = await import("../src/server/evals/trigger");

      draftId = await createForTest(
        {
          name: `verify-trigger-${Date.now()}`,
          purpose: "Probe the trigger lab. Removed at the end of this run.",
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

      const empty = await triggerReport({
        draftId,
        orgId,
        name: "n",
        description: "d",
        body: built.body,
      });
      check(
        "a draft with no probes reports unknown, not zero",
        empty.recall === null && empty.precision === null,
        "not measured",
      );

      /*
       * Four probes, four verdicts, written directly. Driving a model here would make the check
       * depend on what the model said rather than on how the lab counts — and the counting is
       * the subject.
       */
      const made: string[] = [];
      for (const [kind, prompt] of [
        ["should-trigger", "review this terraform plan"],
        ["should-trigger", "check my plan before apply"],
        ["should-not-trigger", "book me a flight"],
        ["should-not-trigger", "write me a poem"],
      ] as const) {
        const created = await createEval({ draftId, orgId, userId: null, kind, prompt });
        if (created.ok) made.push(created.id);
      }
      check("four probes exist", made.length === 4);

      /*
       * TP, FN, TN, FP in that order — one of each, so a lab that dropped a column or crossed
       * the two directions could not produce the expected pair of rates by accident.
       */
      const verdicts = ["pass", "fail", "pass", "fail"];
      for (let i = 0; i < made.length; i += 1) {
        await owner.query(
          `insert into eval_runs (org_id, eval_id, content_hash, verdict, model)
           values ($1, $2, $3, $4, 'probe')`,
          [orgId, made[i], hash, verdicts[i]],
        );
      }

      const report = await triggerReport({
        draftId,
        orgId,
        name: "n",
        description: "d",
        body: built.body,
      });
      check(
        "one of each verdict gives 50% recall and 50% precision",
        report.recall === 0.5 && report.precision === 0.5,
        `${asPercent(report.recall)} / ${asPercent(report.precision)}`,
      );
      check(
        "and the confusion matrix has one in every cell",
        report.counts.truePositive === 1 &&
          report.counts.falseNegative === 1 &&
          report.counts.trueNegative === 1 &&
          report.counts.falsePositive === 1,
      );
      check("four probes in two directions is thin", report.thin);
      check(
        "and no collision analysis ran, which is distinguishable from finding none",
        report.collisions === null,
      );

      /*
       * Edit the document. Every run is now stale, and a rate built from stale verdicts is a
       * rate about a document nobody is looking at — so both must go back to unknown.
       */
      const edited = await setDraftBlocks(
        draftId,
        orgId,
        [
          { form: "content", depth: null, type: "procedure", text: "Read the plan in full." },
          { form: "content", depth: null, type: "guardrail", text: "Never approve a destroy." },
        ],
        { reason: "edited" },
      );
      const afterEdit = await triggerReport({
        draftId,
        orgId,
        name: "n",
        description: "d",
        body: edited.body,
      });
      check(
        "editing the document makes every rate unknown again, not merely worse",
        afterEdit.recall === null && afterEdit.precision === null && afterEdit.staleProbes === 4,
        `${afterEdit.staleProbes} stale`,
      );

      /*
       * An errored run must not enter either column. Re-run one probe at the current hash with
       * an error verdict: the rate stays unknown because nothing else was judged here either.
       */
      await owner.query(
        `insert into eval_runs (org_id, eval_id, content_hash, verdict, model)
         values ($1, $2, $3, 'error', 'probe')`,
        [orgId, made[0], contentHashOf(edited.body)],
      );
      const afterError = await triggerReport({
        draftId,
        orgId,
        name: "n",
        description: "d",
        body: edited.body,
      });
      check(
        "an errored run does not become a data point",
        afterError.recall === null &&
          afterError.counts.truePositive === 0 &&
          afterError.counts.falseNegative === 0,
        "our outage is not their regression",
      );

      // ---- the collision path, for real ----

      if (!process.argv.includes("--live")) {
        skip(
          "the collision round trip",
          "costs a few embeddings — re-run with --live to exercise it",
        );
      } else {
        const live = await triggerReport({
          draftId,
          orgId,
          name: "terraform-plan-review",
          description:
            "Review a terraform plan before it is applied, flagging destructive changes.",
          body: edited.body,
          includeCollisions: true,
        });

        check(
          "the collision half returns one entry per should-fire probe",
          live.collisions !== null && live.collisions.length === 2,
          `${live.collisions?.length ?? 0} of 2`,
        );
        /*
         * The similarity has to be a real cosine against the corpus index, not a placeholder.
         * Zero would be what a broken batch or a mis-ordered vector list produces, and it would
         * render as a plausible "nothing is close".
         */
        check(
          "each probe carries a real similarity to the skill's own description",
          (live.collisions ?? []).every((c) => c.own > 0 && c.own <= 1),
          (live.collisions ?? []).map((c) => c.own.toFixed(3)).join(", "),
        );
        check(
          "neighbours come back from the corpus index",
          live.coveragePercent > 0,
          `${live.coveragePercent}% of the corpus embedded`,
        );
        /*
         * Whether anything is *nearer* is a fact about the corpus, not something to assert. What
         * must hold is the invariant: a neighbour listed as nearer really is nearer.
         */
        check(
          "and every neighbour reported as nearer really is nearer",
          (live.collisions ?? []).every((c) => c.nearer.every((h) => h.similarity > c.own)),
          `${(live.collisions ?? []).reduce((n, c) => n + c.nearer.length, 0)} contested`,
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
