import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { REVISION_REASONS } from "../src/lib/draft-blocks";
import { MODEL_DEFAULTS, MODEL_TASKS } from "../src/lib/models";
import {
  buildRule,
  confirmRuleFor,
  coverage,
  mayCoHold,
  PARAMETER_REFUSAL_MESSAGE,
  PARAMETER_REFUSALS,
  renderParametersTable,
  renderRule,
  RULE_STATE_META,
  RULE_STATES,
  ruleState,
  textHash,
  type Parameter,
  type RuleRow,
} from "../src/lib/parameters";

/**
 * Parameters, structured rules, coverage (Doc 7 RD.1–RD.3, plan step P4).
 *
 *   pnpm verify:parameters
 *
 * Free. No model is called — detection and the consistency check are the two metered paths and
 * are asserted against the source rather than run. The stored half writes a real draft through the
 * real functions and removes it in a `finally`.
 *
 * ## The three properties this file exists to protect
 *
 * 1. **Not measurable is not 0%.** A parameter with no declared values, or a number, has no case
 *    space to cover. The naive division answers `NaN` or `0`, and `0%` on a parameter nobody has
 *    scoped reads as failure where it should read as unmeasured. Reproduced first.
 * 2. **Structure → prose is deterministic, and an edited render detaches.** The same rows render
 *    to the same bytes every time, and a sentence the author edited is *out of date*, never
 *    silently re-rendered — the shared-block rule, one feature over.
 * 3. **Nothing here gates publishing, and nothing here writes the body.** Coverage is a finding.
 *    `publishDraft` never imports this module, and every text change goes through the one block
 *    writer.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const env: Parameter = { name: "environment", kind: "enum", values: ["prod", "staging", "dev"] };
const size: Parameter = { name: "change size", kind: "number", values: [] };
const bare: Parameter = { name: "severity", kind: "enum", values: [] };

const prodRow: RuleRow = { when: [{ parameter: "environment", op: "is", value: "prod" }], then: "require two approvals" };
const stagingRow: RuleRow = { when: [{ parameter: "environment", op: "is", value: "staging" }], then: "require one approval" };
const devRow: RuleRow = { when: [{ parameter: "environment", op: "is", value: "dev" }], then: "merge on green" };
const otherwiseRow: RuleRow = { when: [], then: "ask before merging", otherwise: true };

console.info("\nTwo kinds of zero");

/* The naive form first, so the fixture is proven to produce the wrong answer. */
const naive = (covered: number, declared: number) => Math.round((covered / declared) * 100);
check(
  "the naive division over nothing declared is NaN, and rounded it would be a number",
  Number.isNaN(naive(0, 0)),
  "0/0 — what a bar would show is whatever the renderer does with NaN, which is usually 0%",
);
const unmeasurable = coverage([bare, size], [{ rows: [prodRow] }]);
check(
  "an enum with no values is not measurable, not 0%",
  unmeasurable.parameters[0].measurable === false && unmeasurable.parameters[0].share === null,
  `${unmeasurable.parameters[0].name}: share ${String(unmeasurable.parameters[0].share)}`,
);
check(
  "a number is not measurable either, and its rules are still counted as rules",
  unmeasurable.parameters[1].measurable === false && unmeasurable.parameters[1].share === null,
);
check(
  "the refusal for an enum with no values names the alternative",
  PARAMETER_REFUSAL_MESSAGE["enum-without-values"].includes("another kind"),
);

console.info("\nCoverage arithmetic");

const two = coverage([env], [{ rows: [prodRow, stagingRow] }]);
check(
  "two of three values covered is 67% with the missing one named",
  two.parameters[0].covered === 2 && two.parameters[0].share === 67 && two.parameters[0].missing.join() === "dev",
  `missing: ${two.parameters[0].missing.join(", ")}`,
);
const closed = coverage([env], [{ rows: [prodRow, otherwiseRow] }]);
check(
  "an otherwise row counts as covering every remaining value",
  closed.parameters[0].covered === 3 && closed.parameters[0].missing.length === 0,
  "a skill may say 'any other case: ask' and that is a rule, not a hole",
);
const unused = coverage([env, size], [{ rows: [prodRow] }]);
check("a parameter no rule names is unused, and allowed", unused.parameters[1].rows === 0);
const joint = coverage(
  [env, { name: "risk", kind: "enum", values: ["low", "high"] }],
  [{ rows: [{ when: [{ parameter: "environment", op: "is", value: "prod" }, { parameter: "risk", op: "is", value: "high" }], then: "block" }] }],
);
check(
  "joint coverage exists only for a pair some row combines, and is 1 of 6 here",
  joint.joint.length === 1 && joint.joint[0].combinations === 6 && joint.joint[0].covered === 1,
);
check(
  "and no joint number is invented for parameters no rule combines",
  coverage([env, { name: "risk", kind: "enum", values: ["low", "high"] }], [{ rows: [prodRow] }]).joint.length === 0,
);
check(
  "candidates and detached rows are not the maths' problem — the caller filters, the function counts",
  coverage([env], []).parameters[0].covered === 0 && coverage([env], []).parameters[0].measurable,
);

console.info("\nThe render is deterministic, and an edit detaches");

const rows = [prodRow, stagingRow, devRow];
const table = renderRule(rows);
check("three rows render to a table", table.startsWith("| environment | Then |") && table.split("\n").length === 5, table.split("\n")[0]);
check("one row renders to a sentence", renderRule([prodRow]).startsWith("If **environment** is `prod`, then require two approvals"));
check("the render is byte-stable across two calls", renderRule(rows) === table && renderRule([...rows]) === table);
const rule = buildRule(rows, true);
check("a built rule hashes its own render", rule.renderHash === textHash(table));
check("the rendered text is in step", ruleState({ text: table, rule }) === "in-step");
check(
  "an edited render is detached, not re-rendered",
  ruleState({ text: `${table}\n| \`test\` | run the suite |`, rule }) === "detached",
  RULE_STATE_META.detached.label,
);
check("an unconfirmed structure is a candidate whatever the text", ruleState({ text: table, rule: buildRule(rows, false) }) === "candidate");
check("no structure is prose", ruleState({ text: "If it rains, stay in.", rule: null }) === "none");
const prose = "When we deploy to prod, get two people to approve it first.";
check(
  "confirming a candidate against the author's sentence puts that sentence in step",
  ruleState({ text: prose, rule: confirmRuleFor(prose, buildRule([prodRow], false)) }) === "in-step",
  "the structure now describes the sentence it was read from, not a render nobody wrote",
);
check(
  "an empty action renders as an ellipsis, visibly unfinished",
  renderRule([{ when: [{ parameter: "environment", op: "is", value: "dev" }], then: "" }]).endsWith("then …"),
);
check("every rule state has its own sentence", RULE_STATES.length === 4 && new Set(RULE_STATES.map((s) => RULE_STATE_META[s].blurb)).size === 4);
check(
  "the Parameters table renders accepted parameters only",
  renderParametersTable([env, { ...bare, decision: "rejected" }, { name: "x", kind: "free", values: [], decision: "pending" }]).split("\n").length === 3,
);

console.info("\nWhat may be compared");

check("two values of one parameter cannot both hold", !mayCoHold(prodRow, stagingRow));
check("the same value can", mayCoHold(prodRow, { ...prodRow, then: "notify the channel" }));
check("rules on disjoint parameters can both hold", mayCoHold(prodRow, { when: [{ parameter: "change size", op: "above", value: "500" }], then: "split it" }));
check(
  "disjoint ranges cannot",
  !mayCoHold(
    { when: [{ parameter: "change size", op: "above", value: "500" }], then: "a" },
    { when: [{ parameter: "change size", op: "below", value: "300" }], then: "b" },
  ),
);
check("an otherwise row is never paired", !mayCoHold(prodRow, otherwiseRow));

console.info("\nVocabulary and plumbing");

check("every refusal has its own sentence", new Set(PARAMETER_REFUSALS.map((r) => PARAMETER_REFUSAL_MESSAGE[r])).size === PARAMETER_REFUSALS.length, `${PARAMETER_REFUSALS.length} refusals`);
check("a table made from sentences is distinguishable in the revision history", (REVISION_REASONS as readonly string[]).includes("parameters"));
check(
  "detection is a model task with a priced default",
  (MODEL_TASKS as readonly string[]).includes("parameters") && MODEL_DEFAULTS.parameters.length > 0,
  MODEL_DEFAULTS.parameters,
);

const strip = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const server = strip("src/server/builder/parameters.ts");
check(
  "the module never writes skill_drafts.body",
  !/skillDrafts[\s\S]{0,400}body:/.test(server) && !/update\(skillDrafts\)/.test(server),
  "every text change goes through setDraftBlocks",
);
const directSets = [...server.matchAll(/update\(draftBlocks\)[\s\S]{0,200}?\.set\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
check(
  "its only direct writes to draft_blocks set the rule column and never the text",
  directSets.length > 0 && directSets.every((s) => /\brule\b/.test(s) && !/\btext\b/.test(s)),
  `${directSets.length} direct set(s), structure only — the body is a render of the text and the text did not move`,
);
check("the body writer carries the rule through a save", /rule:/.test(strip("src/server/builder/blocks.ts")));
for (const path of [
  "src/components/builder/block-editor.tsx",
  "src/server/interview/decide.ts",
  "src/server/builder/shared.ts",
  "src/server/builder/improve.ts",
]) {
  check(`${path} carries the rule when it rewrites the list`, /rule: block\.rule/.test(strip(path)), "or a save from elsewhere would strip a table's rows");
}
check(
  "the publish gate never consults parameters or coverage",
  !/parameters|coverage/i.test(strip("src/server/builder/publish.ts")),
  "R4.5 stays the only gate; a skill may leave a case to the agent",
);
check(
  "detection and consistency are metered — budget before, ledger after",
  (server.match(/assertWithinBudget\(/g) ?? []).length >= 4 && (server.match(/recordUsage\(/g) ?? []).length === 2,
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
    `select to_regclass('public.draft_parameters') is not null
        and exists (select 1 from information_schema.columns where table_name = 'draft_blocks' and column_name = 'rule') as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  draft_parameters or draft_blocks.rule absent — run pnpm db:generate, read the SQL, then pnpm db:migrate");
  } else {
    /*
     * A stored coverage figure is the thing this design refuses to have, so the check is a scan
     * for one — and its first version matched `shared_block_id` and `shared_block_version`,
     * E6's transclusion columns, because "shared" contains "share". A substring scan over
     * identifiers accuses whatever happens to spell a word inside another one, which is the
     * same fault as the scanner that matched the *warnings* about `= any(${array})`.
     *
     * Segments, therefore: a column name is `_`-separated words, and a forbidden word has to be
     * one of them. `shared` is not `share`; `coverage_percent` still is.
     */
    const FORBIDDEN = new Set(["coverage", "covered", "share", "percent", "complete", "completeness"]);
    const storesFigure = (column: string) => column.split("_").some((word) => FORBIDDEN.has(word));
    check(
      "the scan can still see a stored figure",
      storesFigure("coverage_percent") && storesFigure("covered") && storesFigure("share"),
      "a scan that matches nothing passes for the wrong reason",
    );
    check(
      "and does not accuse a column that merely spells one inside another word",
      !storesFigure("shared_block_id") && !storesFigure("shared_block_version"),
      "E6's transclusion columns, which the first version of this check reported",
    );
    check(
      "no column stores a coverage figure",
      !(
        await c.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name in ('draft_parameters','draft_blocks')`,
        )
      ).rows.some((r) => storesFigure(r.column_name)),
      "derived on read, so it cannot describe rules the author has since edited",
    );
    check(
      "two spellings of one parameter are one parameter",
      (await c.query<{ n: string }>(`select count(*)::text as n from pg_indexes where tablename = 'draft_parameters' and indexdef ilike '%lower(name)%'`)).rows[0].n === "1",
    );

    const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
    const { rows: who } = await c.query<{ id: string }>(`select id from "user" order by created_at limit 1`);
    if (org.length === 0 || who.length === 0) {
      console.info("  skip  needs one organisation and one account");
    } else {
      const orgId = org[0].id;
      const userId = who[0].id;
      const { setDraftBlocks, getDraftBlocks } = await import("../src/server/builder/blocks");
      const { skillDrafts } = await import("../src/server/db/schema");
      const { withExplicitOrgScope } = await import("../src/server/dal/scope");
      const { addRuleRow, coverageFor, declareParameter, decideRule, deleteParameter, makeTable } =
        await import("../src/server/builder/parameters");

      let draftId: string | null = null;
      try {
        draftId = await withExplicitOrgScope(orgId, async (tx) => {
          const [row] = await tx
            .insert(skillDrafts)
            .values({
              orgId,
              name: "verify:parameters probe",
              slug: `verify-parameters-probe-${Date.now()}`,
              purpose: "probe",
              archetypeCategory: "review",
              frontmatter: { name: "verify-parameters-probe", description: "A probe: it checks coverage." },
            })
            .returning({ id: skillDrafts.id });
          return row.id;
        });

        /* Three sentences, each with confirmed structure — the "scattered conditionals" case. */
        await setDraftBlocks(
          draftId,
          orgId,
          [
            { form: "heading", depth: 2, text: "Approvals" },
            ...[prodRow, stagingRow].map((row) => {
              const text = renderRule([row]);
              return { form: "content" as const, type: "decision-rule" as const, text, rule: buildRule([row], true) };
            }),
            { form: "content", type: "guardrail", text: "Never force-push to a shared branch." },
          ],
          { reason: "edited", createdBy: userId },
        );

        const declared = await declareParameter({ orgId, userId, draftId, parameter: { name: "Environment", kind: "enum", values: ["prod", "staging", "dev"] } });
        check("a parameter is declared", declared.ok);
        const dupe = await declareParameter({ orgId, userId, draftId, parameter: { name: "environment", kind: "enum", values: ["x"] } });
        check("a parameter differing only in case is refused", !dupe.ok && dupe.refusal === "duplicate-name", "the folded index decides");
        const noValues = await declareParameter({ orgId, userId, draftId, parameter: { name: "severity", kind: "enum", values: [] } });
        check("an enum without values is refused, not stored as a promise", !noValues.ok && noValues.refusal === "enum-without-values");

        let blocks = await getDraftBlocks(draftId, orgId);
        check(
          "declaring wrote the Parameters table into the body through the block writer",
          blocks.some((b) => b.type === "glossary" && b.text.startsWith("| Parameter |")) && blocks.some((b) => b.form === "heading" && b.text === "Parameters"),
        );
        check("and the rules kept their structure through that save", blocks.filter((b) => b.rule?.confirmed).length === 2);

        let report = await coverageFor(draftId, orgId);
        check(
          "coverage over stored rows: 2 of 3, dev missing",
          report.coverage.parameters[0]?.covered === 2 && report.coverage.parameters[0]?.missing.join() === "dev",
          `${report.coverage.parameters[0]?.covered} of ${report.coverage.parameters[0]?.declared}`,
        );

        /* The author edits one rendered sentence. Its structure must detach, and coverage must drop. */
        blocks = await getDraftBlocks(draftId, orgId);
        const staging = blocks.find((b) => b.rule && b.text.includes("staging"));
        await setDraftBlocks(
          draftId,
          orgId,
          blocks.map((b) => ({ id: b.id, form: b.form, depth: b.depth, type: b.type, text: b.id === staging?.id ? `${b.text} (and tell the channel)` : b.text, rule: b.rule ?? null })),
          { reason: "edited", createdBy: userId },
        );
        report = await coverageFor(draftId, orgId);
        check(
          "an edited render detaches and stops counting",
          report.rules.some((r) => r.state === "detached") && report.coverage.parameters[0]?.covered === 1,
          `${report.coverage.parameters[0]?.covered} covered after the edit`,
        );
        check("the edited sentence was not re-rendered", (await getDraftBlocks(draftId, orgId)).some((b) => b.text.endsWith("(and tell the channel)")));

        /* Re-confirm against the edited sentence: it is in step again, describing the new text. */
        const confirmed = await decideRule({ orgId, userId, draftId, blockId: staging!.id, decision: "confirm" });
        check("confirming against the edited sentence puts it back in step", confirmed.ok && confirmed.data.state === "in-step");

        /* Add a rule for the hole. Empty action, condition filled in. */
        const added = await addRuleRow({ orgId, userId, draftId, parameter: "environment", value: "dev", blockId: null });
        check("an uncovered case gets an empty rule, never anybody's action", added.ok && (await getDraftBlocks(draftId, orgId)).some((b) => b.text === "If **environment** is `dev`, then …"));
        report = await coverageFor(draftId, orgId);
        check("and coverage is now complete", report.coverage.parameters[0]?.covered === 3);

        /* Make the three sentences one table. */
        blocks = await getDraftBlocks(draftId, orgId);
        const ruleIds = blocks.filter((b) => b.type === "decision-rule" && b.rule?.confirmed).map((b) => b.id);
        const merged = await makeTable({ orgId, userId, draftId, blockIds: ruleIds });
        blocks = await getDraftBlocks(draftId, orgId);
        check(
          "three sentences became one table, in the first one's place",
          merged.ok && merged.data.rows === 3 && blocks.filter((b) => b.type === "decision-rule").length === 1 && blocks.find((b) => b.type === "decision-rule")?.text.startsWith("| environment | Then |") === true,
        );
        check("the history says so", (await c.query<{ n: string }>(`select count(*)::text as n from draft_revisions where draft_id = $1 and reason = 'parameters'`, [draftId])).rows[0].n !== "0");
        const tooFew = await makeTable({ orgId, userId, draftId, blockIds: ruleIds.slice(0, 1) });
        check("one block is not a table", !tooFew.ok && tooFew.refusal === "too-few-blocks");

        /* Delete the parameter: the rule stays, as prose about a word. */
        const params = report.parameters;
        const removed = await deleteParameter({ orgId, userId, draftId, id: params[0].id });
        blocks = await getDraftBlocks(draftId, orgId);
        check(
          "deleting the parameter leaves the rules and removes the table from the body",
          removed.ok && blocks.some((b) => b.type === "decision-rule" && b.rule) && !blocks.some((b) => b.text.startsWith("| Parameter |")),
        );
        report = await coverageFor(draftId, orgId);
        check("nothing is measured for a parameter that is gone", report.coverage.parameters.length === 0);
        check(
          "the draft is still ready to publish — a hole was never a gate",
          (await c.query<{ status: string }>(`select status from skill_drafts where id = $1`, [draftId])).rows[0].status === "ready",
        );
      } finally {
        if (draftId) await c.query(`delete from skill_drafts where id = $1`, [draftId]);
        const { rows: left } = await c.query<{ n: string }>(
          `select (select count(*) from skill_drafts where name = 'verify:parameters probe')
                + (select count(*) from draft_parameters p where not exists (select 1 from skill_drafts d where d.id = p.draft_id)) as n`,
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
