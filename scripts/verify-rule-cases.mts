import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { EVAL_SOURCE_LABEL, EVAL_SOURCES, isEvalSource } from "../src/lib/evals";
import { buildRule, renderRule, RULE_OPERATOR_LABEL, type RuleRow } from "../src/lib/parameters";
import {
  MAX_RULE_CASE_PROPOSALS,
  RULE_CASE_SKIP_MESSAGE,
  RULE_CASE_SKIPS,
  conditionPhrase,
  isRuleCaseProposal,
  proposeFor,
  ruleCaseKey,
  ruleCasePrompt,
  ruleCaseReport,
} from "../src/lib/rule-cases";

/**
 * Every table row is a test case waiting to be accepted (Doc 7 RD.4, plan step P6).
 *
 *   pnpm verify:rule-cases
 *
 * Free, and it stays free by construction: proposing is a render, so there is no model to mock
 * and no metered path to assert against the source. The stored half writes a real draft through
 * the real functions and removes it in a `finally`.
 *
 * ## The four properties this file exists to protect
 *
 * 1. **A row that cannot be tested proposes nothing.** The naive reading — every row becomes a
 *    golden task — produces an unjudgeable case from the empty action "add a rule here" writes,
 *    and a request framed from an `otherwise` row that describes no situation. Both are
 *    reproduced before the refusals are asserted.
 * 2. **The expectation is the author's sentence, verbatim.** No model, no tidying, no added
 *    punctuation.
 * 3. **The key tracks the claim, not the sentence and not the block.** Reordering conditions and
 *    merging rules into a table must not re-propose a case that exists; changing the action
 *    must, and must leave the case already written alone.
 * 4. **Nothing here gates publishing.** A draft whose every rule is untested still publishes.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const prodRow: RuleRow = {
  when: [{ parameter: "environment", op: "is", value: "prod" }],
  then: "require two approvals",
};
const stagingRow: RuleRow = {
  when: [{ parameter: "environment", op: "is", value: "staging" }],
  then: "require one approval",
};
const pairRow: RuleRow = {
  when: [
    { parameter: "environment", op: "is", value: "prod" },
    { parameter: "change size", op: "at-least", value: "500" },
  ],
  then: "ask the owning team before merging",
};
const emptyRow: RuleRow = {
  when: [{ parameter: "environment", op: "is", value: "dev" }],
  then: "",
};
const otherwiseRow: RuleRow = { when: [], then: "use judgment and say so", otherwise: true };

console.info("\nThe naive reading, first");

/*
 * Every row becomes a golden task. It reads as obviously right, and it is what a first version
 * would write — so the two rows it gets wrong are shown producing the wrong case before the real
 * rule is asked about them.
 */
const naive = (row: RuleRow) => ({
  prompt: `Given that ${row.when.map((c) => `${c.parameter} ${c.op} ${c.value}`).join(" and ")}, what should be done?`,
  expectation: row.then,
});

check(
  "the naive reading turns an empty action into a case with no expectation",
  naive(emptyRow).expectation === "",
  "a golden task with nothing to check fails every run for our reason, not the skill's",
);
check(
  "and turns an otherwise row into a request that frames no situation",
  naive(otherwiseRow).prompt === "Given that , what should be done?",
  "defined by what it is not, so there is nothing to put to an agent",
);

const skippedEmpty = proposeFor("b1", emptyRow, 0);
check(
  "the real rule refuses the empty action and says why",
  !isRuleCaseProposal(skippedEmpty) && skippedEmpty.reason === "no-action",
);
const skippedOtherwise = proposeFor("b1", otherwiseRow, 1);
check(
  "and refuses the otherwise row",
  !isRuleCaseProposal(skippedOtherwise) && skippedOtherwise.reason === "otherwise-row",
);
const skippedBare = proposeFor("b1", { when: [], then: "do something" }, 2);
check(
  "and a row naming no parameter",
  !isRuleCaseProposal(skippedBare) && skippedBare.reason === "no-conditions",
);
check(
  "every skip reason has a sentence an author can act on",
  RULE_CASE_SKIPS.every((reason) => RULE_CASE_SKIP_MESSAGE[reason].length > 20),
);

console.info("\nWhat a row proposes");

const prod = proposeFor("b1", prodRow, 0);
if (!isRuleCaseProposal(prod)) throw new Error("the fixture stopped proposing");

check("a row with a condition and an action proposes a golden task", prod.kind === "golden-task");
check(
  "the expectation is the author's action, character for character",
  prod.expectation === prodRow.then,
  JSON.stringify(prod.expectation),
);
check(
  "nothing is appended to it — not a full stop, not a framing clause",
  !prod.expectation.endsWith(".") && prod.expectation.length === prodRow.then.length,
);
check(
  "the request names the situation",
  prod.prompt === "Given that environment is prod, what should be done?",
  prod.prompt,
);
/*
 * D3 runs the identical prompt with the document withheld. A request that says "this skill"
 * is unanswerable in that arm, and the arm is the point of having the case: a rule the model
 * reproduces unaided carries no knowledge the agent lacked.
 */
check(
  "and never mentions the skill, because the without-arm runs the same words",
  !/\bskill\b|\bdocument\b/i.test(prod.prompt),
);
check(
  "no markdown reaches a prompt — that is a request, not a passage of the document",
  !/[*`|]/.test(prod.prompt),
  `renderRule emits ${renderRule([prodRow]).includes("**") ? "bold" : "plain"} for the same row`,
);

const pair = proposeFor("b1", pairRow, 0);
check(
  "two conditions are joined with and, in the operator's own words",
  isRuleCaseProposal(pair) &&
    pair.prompt === "Given that environment is prod and change size is at least 500, what should be done?",
  isRuleCaseProposal(pair) ? pair.prompt : "refused",
);
check(
  "the operator words come from the one table, not a second copy",
  conditionPhrase({ parameter: "x", op: "at-most", value: "3" }) ===
    `x ${RULE_OPERATOR_LABEL["at-most"]} 3`,
);
check(
  "a one-of condition reads as a choice rather than a list",
  conditionPhrase({ parameter: "environment", op: "in", value: "prod, staging" }) ===
    "environment is prod or staging",
);
/*
 * Two independently built rows that say the same thing, not the same object twice — comparing an
 * input with itself is a condition that cannot fail, which this codebase has shipped before.
 */
const rebuilt: RuleRow = JSON.parse(JSON.stringify(pairRow)) as RuleRow;
check(
  "the render is deterministic: the same rule twice is the same bytes",
  ruleCasePrompt(pairRow) === ruleCasePrompt(rebuilt) && rebuilt !== pairRow,
);

console.info("\nThe key tracks the claim");

check(
  "the same row proposes the same key from a different block",
  ruleCaseKey(prodRow) === ruleCaseKey({ ...prodRow }) &&
    (proposeFor("b1", prodRow, 0) as { key: string }).key ===
      (proposeFor("b2", prodRow, 7) as { key: string }).key,
  "make-this-a-table moves rows between blocks; a link that broke there would be a lie",
);
check(
  "reordering conditions is the same claim",
  ruleCaseKey(pairRow) === ruleCaseKey({ ...pairRow, when: [...pairRow.when].reverse() }),
);
check(
  "capitalising the action is the same claim",
  ruleCaseKey(prodRow) === ruleCaseKey({ ...prodRow, then: "Require Two Approvals" }),
);
check(
  "rewriting the action is a different claim, and re-proposes on purpose",
  ruleCaseKey(prodRow) !== ruleCaseKey({ ...prodRow, then: "require three approvals" }),
);
check(
  "changing a condition's value is a different claim",
  ruleCaseKey(prodRow) !== ruleCaseKey({ ...prodRow, when: [{ parameter: "environment", op: "is", value: "staging" }] }),
);

console.info("\nThe report, and which zero it is");

const empty = ruleCaseReport([], new Set());
check(
  "no structured rules is not the same as everything covered",
  empty.blocks === 0 && empty.proposals.length === 0 && empty.covered === 0,
  "the panel prints a different sentence for each",
);

const fresh = ruleCaseReport([{ id: "b1", rows: [prodRow, stagingRow, emptyRow, otherwiseRow] }], new Set());
check(
  "two proposable rows out of four, and the other two are reported",
  fresh.proposals.length === 2 && fresh.skipped.length === 2 && fresh.rows === 4,
  `${fresh.proposals.length} proposals · ${fresh.skipped.length} skipped`,
);

const partly = ruleCaseReport(
  [{ id: "b1", rows: [prodRow, stagingRow] }],
  new Set([ruleCaseKey(prodRow)]),
);
check(
  "a row whose case exists is covered, not proposed",
  partly.covered === 1 && partly.proposals.length === 1 && partly.proposals[0].key === ruleCaseKey(stagingRow),
);

const twice = ruleCaseReport([{ id: "b1", rows: [prodRow, { ...prodRow }] }], new Set());
check(
  "the identical claim twice in one table is one offer",
  twice.proposals.length === 1 && twice.covered === 1,
  "a merged table can hold it twice; accepting both would cost a model call for ever",
);

const many = ruleCaseReport(
  [
    {
      id: "b1",
      rows: Array.from({ length: MAX_RULE_CASE_PROPOSALS + 5 }, (_, i) => ({
        when: [{ parameter: "environment", op: "is" as const, value: `v${i}` }],
        then: `do thing ${i}`,
      })),
    },
  ],
  new Set(),
);
check(
  "a long table reports the remainder rather than rendering every button",
  many.proposals.length === MAX_RULE_CASE_PROPOSALS && many.more === 5,
);

console.info("\nThe source vocabulary, and the ternary that could not see a third value");

check("rule is a source", (EVAL_SOURCES as readonly string[]).includes("rule"));
check(
  "every source has a label",
  EVAL_SOURCES.every((source) => Boolean(EVAL_SOURCE_LABEL[source])),
);
/*
 * The read this replaced. It is correct for exactly as long as there are two sources, and P6
 * adds a third — so every case proposed from a rule would have come back labelled as one the
 * author typed, on the one badge that says where a case came from.
 */
const naiveSource = (value: string) => (value === "interview" ? "interview" : "authored");
check(
  "the collapsing ternary reports a rule case as authored",
  naiveSource("rule") === "authored",
);
check("asking the vocabulary does not", isEvalSource("rule") && !isEvalSource("invented"));

console.info("\nWhat the modules may reach");

const strip = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const leaf = strip("src/lib/rule-cases.ts");
check(
  "the proposal render reaches no model, no database and nothing server-only",
  !/generateText|generateObject|\bdb\b|server-only/.test(leaf),
  "a render, so every rule above runs with nothing configured",
);
check(
  "and the scan can see one",
  /server-only/.test(['import "server', '-only";'].join("")),
  "assembled at runtime, so the control is not a literal this very scan would report",
);

const server = strip("src/server/evals/rule-cases.ts");
check(
  "accepting goes through createEval, not a second insert",
  /createEval\(/.test(server) && !/insert\(/.test(server),
  "a case from a rule is an ordinary case the moment it exists",
);
check(
  "and calls no model",
  !/generateText|generateObject|assertWithinBudget/.test(server),
);

const publish = strip("src/server/builder/publish.ts");
check(
  "publishing never reads a proposal",
  !/rule-cases|proposalsFor|acceptRuleCases/.test(publish),
  "R4.5 stays the only gate, and a regression the only eval-shaped block",
);

const action = strip("src/app/(protected)/build/actions.ts");
check(
  "the action takes keys and never a prompt",
  /acceptRuleCasesAction\(\s*draftId: string,\s*keys: string\[\],/.test(action),
  "the case is re-derived on the server, so a caller cannot choose what it says",
);

console.info("\nAgainst a real draft");

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
    `select exists (
       select 1 from information_schema.columns
        where table_name = 'skill_evals' and column_name = 'source_rule'
     ) as present`,
  );
  if (!exists[0].present) {
    console.info(
      "  skip  skill_evals.source_rule absent — run pnpm db:generate, read the SQL, then pnpm db:migrate",
    );
  } else {
    const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
    const { rows: who } = await c.query<{ id: string }>(
      `select id from "user" order by created_at limit 1`,
    );
    if (org.length === 0 || who.length === 0) {
      console.info("  skip  needs one organisation and one account");
    } else {
      const orgId = org[0].id;
      const userId = who[0].id;
      const { setDraftBlocks, getDraftBlocks } = await import("../src/server/builder/blocks");
      const { skillDrafts } = await import("../src/server/db/schema");
      const { withExplicitOrgScope } = await import("../src/server/dal/scope");
      const { makeTable } = await import("../src/server/builder/parameters");
      const { acceptRuleCases, proposalsFor } = await import("../src/server/evals/rule-cases");
      const { evalStates } = await import("../src/server/evals/store");

      let draftId: string | null = null;
      try {
        draftId = await withExplicitOrgScope(orgId, async (tx) => {
          const [row] = await tx
            .insert(skillDrafts)
            .values({
              orgId,
              name: "verify:rule-cases probe",
              slug: `verify-rule-cases-probe-${Date.now()}`,
              purpose: "probe",
              archetypeCategory: "review",
              frontmatter: {
                name: "verify-rule-cases-probe",
                description: "A probe: it checks rule-proposed eval cases.",
              },
            })
            .returning({ id: skillDrafts.id });
          return row.id;
        });
        const draft = { id: draftId, publishedSkillId: null };

        await setDraftBlocks(
          draftId,
          orgId,
          [
            { form: "heading", depth: 2, text: "Approvals" },
            ...[prodRow, stagingRow].map((row) => ({
              form: "content" as const,
              type: "decision-rule" as const,
              text: renderRule([row]),
              rule: buildRule([row], true),
            })),
            {
              form: "content",
              type: "decision-rule",
              text: renderRule([emptyRow, otherwiseRow]),
              rule: buildRule([emptyRow, otherwiseRow], true),
            },
          ],
          { reason: "edited", createdBy: userId },
        );

        let report = await proposalsFor(draft, orgId);
        check(
          "two rules offer a case; the empty action and the otherwise row do not",
          report.proposals.length === 2 && report.skipped.length === 2,
          `${report.proposals.length} offered · ${report.skipped.length} skipped of ${report.rows} rows`,
        );

        const prodKey = ruleCaseKey(prodRow);
        const accepted = await acceptRuleCases({ draft, orgId, userId, keys: [prodKey] });
        check("accepting one writes one case", accepted.created === 1 && accepted.missed === 0);

        let cases = await evalStates({ draftId }, orgId);
        const made = cases.find((row) => row.sourceRule === prodKey);
        check(
          "the case is a golden task carrying the author's action",
          made?.kind === "golden-task" && made?.expectation === prodRow.then,
          made?.expectation ?? "absent",
        );
        /*
         * Read back from the table rather than from the value handed in. The mapping this
         * replaced collapsed every unknown source to `authored`, which no pure check could see
         * because the collapse happens on the way out of the database.
         */
        check(
          "and reads back as a rule case, not as one the author typed",
          made?.source === "rule",
          made?.source ?? "absent",
        );

        report = await proposalsFor(draft, orgId);
        check(
          "the offer is gone and counted as covered",
          report.proposals.length === 1 && report.covered === 1,
        );

        const again = await acceptRuleCases({ draft, orgId, userId, keys: [prodKey] });
        check(
          "accepting a spent offer creates nothing and does not throw",
          again.created === 0 && again.missed === 1,
          "the rule moved while the page was open; nine good accepts must not be lost to one",
        );

        /* Merge the two sentences into one table: the accepted case must stay linked. */
        let blocks = await getDraftBlocks(draftId, orgId);
        const ruleIds = blocks
          .filter((b) => b.type === "decision-rule" && b.rule?.rows.length === 1)
          .map((b) => b.id);
        const merged = await makeTable({ orgId, userId, draftId, blockIds: ruleIds });
        report = await proposalsFor(draft, orgId);
        check(
          "merging rules into a table does not re-offer the case already accepted",
          merged.ok && report.covered === 1 && report.proposals.length === 1,
          "the key excludes the block for exactly this",
        );

        /* The author rewrites the accepted rule's action. */
        blocks = await getDraftBlocks(draftId, orgId);
        const table = blocks.find((b) => b.type === "decision-rule" && (b.rule?.rows.length ?? 0) > 1);
        const rewritten = (table?.rule?.rows ?? []).map((row) =>
          row.when.some((cond) => cond.value === "prod") ? { ...row, then: "require three approvals" } : row,
        );
        await setDraftBlocks(
          draftId,
          orgId,
          blocks.map((b) =>
            b.id === table?.id
              ? {
                  id: b.id,
                  form: b.form,
                  depth: b.depth,
                  type: b.type,
                  text: renderRule(rewritten),
                  rule: buildRule(rewritten, true),
                }
              : { id: b.id, form: b.form, depth: b.depth, type: b.type, text: b.text, rule: b.rule ?? null },
          ),
          { reason: "edited", createdBy: userId },
        );

        report = await proposalsFor(draft, orgId);
        cases = await evalStates({ draftId }, orgId);
        check(
          "rewriting the action offers a case for the new rule",
          report.proposals.some((p) => p.expectation === "require three approvals"),
        );
        check(
          "and leaves the case already written exactly where it is",
          cases.some((row) => row.sourceRule === prodKey && row.expectation === prodRow.then),
          "it is the author's test now, not ours to withdraw",
        );

        check(
          "the draft is still ready to publish with rules untested — a proposal was never a gate",
          (await c.query<{ status: string }>(`select status from skill_drafts where id = $1`, [draftId]))
            .rows[0].status === "ready",
        );
      } finally {
        if (draftId) await c.query(`delete from skill_drafts where id = $1`, [draftId]);
        const { rows: left } = await c.query<{ n: string }>(
          `select (select count(*) from skill_drafts where name = 'verify:rule-cases probe')
                + (select count(*) from skill_evals e
                    where e.source = 'rule'
                      and e.draft_id is not null
                      and not exists (select 1 from skill_drafts d where d.id = e.draft_id)) as n`,
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
