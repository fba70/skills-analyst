import "dotenv/config";

import { readFileSync } from "node:fs";

import { MockLanguageModelV4 } from "ai/test";
import { Client } from "pg";

import {
  CONFLICT_MINER_VERSION,
  CONFLICT_MIN_SIMILARITY,
  isSymmetric,
  MAX_GUARDRAILS_PER_SIDE,
  RELATION_KINDS,
  RELATION_META,
  STORED_KINDS,
  SYMMETRIC_KINDS,
} from "../src/lib/relations";

/**
 * The graph stores only what has nowhere else to live (Doc 6 RK.3, plan step E2).
 *
 *   pnpm verify:relations
 *
 * Free. The miner is driven with an `ai/test` mock, so no provider is reached; the rows are
 * removed in a `finally`.
 *
 * ## What is actually at risk
 *
 * Not the table. The two things that make a graph rot:
 *
 *   1. **Storing an edge that already has a home.** `similar-to` lives in the A6 vectors and
 *      `supersedes` on `skills.superseded_by_skill_id`. A stored copy of either is a snapshot: a
 *      re-embed moves similarity, and A4 made supersession a live join *precisely* so a
 *      replacement quarantined since stops being recommended. Both would go stale silently and
 *      look right for months.
 *   2. **A symmetric edge that exists from one side only.** A conflict warning that appears on one
 *      skill's page and not the other's is invisible until somebody compares two pages, and the
 *      install-time warning would fire for half the callers it should.
 *
 * And one that makes it unaffordable: a model call for every near pair, including the ones about
 * entirely different objects.
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

// ---------------------------------------------------------------------------------------
console.info("\nWhat is stored, and what deliberately is not");
// ---------------------------------------------------------------------------------------

check(
  "similarity is not a storable kind",
  !STORED_KINDS.includes("similar-to"),
  "it lives in the A6 index; a copy is a snapshot that a re-embed invalidates",
);
check(
  "and neither is supersession",
  !STORED_KINDS.includes("supersedes") && !STORED_KINDS.includes("superseded-by"),
  "A4 made it a live join so a quarantined replacement stops being recommended",
);
check(
  "conflicts are, because a model call per pair cannot be redone on a page load",
  STORED_KINDS.includes("conflicts-with"),
);
check(
  "and declared edges are, because an assertion exists nowhere else",
  STORED_KINDS.includes("requires") && STORED_KINDS.includes("part-of"),
);

check(
  "conflicts and similarity read the same from either end",
  isSymmetric("conflicts-with") && isSymmetric("similar-to") && !isSymmetric("supersedes"),
  SYMMETRIC_KINDS.join(", "),
);

check(
  "every kind has a label and says whether it is a caution",
  RELATION_KINDS.every((kind) => RELATION_META[kind]?.label.length > 0),
  `${RELATION_KINDS.length} kinds`,
);
check(
  "a conflict is a caution and a similarity is not",
  RELATION_META["conflicts-with"].caution && !RELATION_META["similar-to"].caution,
);

// ---------------------------------------------------------------------------------------
console.info("\nThe reader composes rather than duplicating");
// ---------------------------------------------------------------------------------------

{
  const src = readFileSync("src/server/analytics/relations.ts", "utf8");

  check(
    "similarity is resolved with a vector lookup, not read from the table",
    /embedding <=> mine\.embedding/.test(src),
  );
  check(
    "supersession is read from the skills column A4 owns",
    /superseded_by_skill_id/.test(src) && /supersededBySkillId/.test(src),
  );
  /*
   * The write path must refuse the derived kinds. Silently ignoring them would leave a caller
   * believing an edge was recorded, and accepting them would create the stale copy.
   */
  check(
    "declaring a derived kind is refused, and the refusal says where the answer lives",
    /Similarity is measured from the embedding index/.test(src) &&
      /pnpm lifecycle --supersede/.test(src),
  );
  check(
    "every resolved edge is filtered to indexed skills",
    (src.match(/status, "indexed"/g) ?? []).length >= 3,
    "an edge into a withdrawn skill is a recommendation into a 404",
  );
  /*
   * Symmetric edges are written as a pair in one statement. One row would make the install-time
   * warning fire for half the callers it should, and nothing would look wrong.
   */
  check(
    "a symmetric edge is written in both directions at once",
    /isSymmetric\(input\.kind\)/.test(src) && /rows\.push\(/.test(src),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nWhat makes the miner affordable");
// ---------------------------------------------------------------------------------------

{
  const src = readFileSync("src/server/analytics/conflicts.ts", "utf8");

  check(
    "only near neighbours are compared",
    /CONFLICT_MIN_SIMILARITY/.test(src),
    `similarity >= ${CONFLICT_MIN_SIMILARITY}`,
  );
  check(
    "only skills that actually carry guardrails",
    /b\.type = 'guardrail'/.test(src),
    "A2 named guardrail as the input to RK.3; it was written for this",
  );
  /*
   * The lexical gate. Without it the model is asked, thousands of times, whether a Terraform rule
   * and a legal-review rule contradict — and the answer is always no, at a fraction of a cent each.
   */
  check(
    "and only pairs whose rules share a significant word",
    /sharesTerm\(/.test(src),
  );
  check(
    "each pair is one call, not one per guardrail pair",
    /MAX_GUARDRAILS_PER_SIDE/.test(src) && !/for \(const left of/.test(src),
    `both sides sent together, ${MAX_GUARDRAILS_PER_SIDE} rules each`,
  );
  check(
    "the pair ordering stops every comparison happening twice",
    /a\.id < b\.id/.test(src),
    "the writer mirrors symmetric edges, so one call produces both directions",
  );
  check(
    "already-decided pairs are skipped at the current miner version",
    /miner_version = \$\{CONFLICT_MINER_VERSION\}/.test(src) || /r\.miner_version =/.test(src),
    CONFLICT_MINER_VERSION,
  );
  check(
    "verdicts are produced at temperature zero",
    /temperature: 0,/.test(src),
    "a conflict is a claim somebody acts on, so a re-run must reproduce it",
  );
  check(
    "the budget is checked before each call",
    /assertWithinBudget\("corpus_validation", null\)/.test(src),
    "platform budget: this is corpus analysis, not a customer's",
  );
  /*
   * The prompt has to rule out the three things that look like conflicts and are not. Without
   * them the model reports every stricter-than pair, and the panel becomes noise.
   */
  check(
    "the prompt excludes stricter-than, different-circumstance and reworded rules",
    /stricter/.test(src) && /different stated circumstances/.test(src) && /different words/.test(src),
  );
  check(
    "and says an empty list is the normal answer",
    /empty list is the normal answer/.test(src),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nA trap this codebase has now hit four times");
// ---------------------------------------------------------------------------------------

/**
 * `= any(${jsArray})` inside a `sql` template, scanned across the whole tree.
 *
 * Drizzle renders a JS array in a template as a **row constructor** — `($1, $2)` — which is what
 * `in` takes and is not an array. Postgres answers *op ANY/ALL (array) requires array on right
 * side*, or *malformed array literal*, and only at runtime.
 *
 * **Four occurrences.** The lifecycle branch, E1's link prune, this step's guardrail lookup — and
 * a fourth the scan itself found: `deleteStoredBundles` in the takedown path, guarding an
 * irreversible bundle delete, which had been latent since it was written because the branch
 * containing it cannot currently fire. Each read perfectly naturally, each passed typecheck and
 * lint, and each failed only when executed.
 *
 * A comment in one file cannot stop the fifth, so this is a scan — and it lives here, in the suite
 * for the step that hit it most recently, because it guards every file.
 *
 * `inArray` and `notInArray` are the safe forms and are what the fix always is.
 */
{
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      /*
       * Comments stripped first. The first version matched the *warnings* about this trap — three
       * of its five hits were prose in the very files that had already been fixed, which is a
       * scanner that reports loudest where the problem is least. It also has to allow the correct
       * form, `any(${sql`array[...]`})`, which builds a real array expression rather than
       * interpolating a JS one.
       */
      const source = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/\b(any|all)\(\$\{(?!sql`array\[)/.test(source)) offenders.push(path);
    }
  };
  walk("src");

  check(
    "no sql template interpolates a JS array into any() or all()",
    offenders.length === 0,
    offenders.length === 0 ? "use inArray / notInArray" : offenders.join(", "),
  );
  /*
   * The scan must be able to see its subject. A walk that read nothing would pass silently — the
   * shape `verify:blocks` shipped when it went green on an empty table.
   */
  check(
    "and the scan actually walked the tree",
    readdirSync("src").length > 3,
    `${readdirSync("src").length} entries under src`,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe install-time warning");
// ---------------------------------------------------------------------------------------

{
  const mcp = readFileSync("src/server/mcp/tools.ts", "utf8");
  check(
    "get_skill carries conflicts",
    /conflicts_with:/.test(mcp) && /conflictsFor\(/.test(mcp),
  );
  check(
    "and so does download_skill, which is the last moment it can matter",
    /conflictsForSlug\(/.test(mcp),
    "an agent is not obliged to read a skill before taking it",
  );
  /*
   * It warns and does not refuse. The refusals here are for things nobody may do — a withdrawn
   * skill, an unlicensed one — and a conflict is a measurement the caller may have good reason to
   * override.
   */
  check(
    "it warns rather than refusing",
    /warning:/.test(mcp) && !/reason: "conflicts"/.test(mcp),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nAgainst the real tables");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
let tableExists = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("table checks", "no database connection — the checks above are complete without it");
}

const PROBE_DETAIL = "verify-relations probe edge";

if (connected) {
  try {
    tableExists =
      (
        await owner.query<{ n: string }>(
          `select count(*)::text as n from information_schema.tables
            where table_schema = 'public' and table_name = 'skill_relations'`,
        )
      ).rows[0].n !== "0";

    if (!tableExists) {
      skip("table checks", "skill_relations does not exist — apply migrations/0040");
    } else {
      const policies = await owner.query<{ qual: string | null }>(
        `select qual from pg_policies where tablename = 'skill_relations'`,
      );
      check(
        "the table is org-scoped with a public escape hatch",
        policies.rowCount === 1 &&
          /org_id IS NULL/i.test(policies.rows[0].qual ?? "") &&
          /current_setting/.test(policies.rows[0].qual ?? ""),
        "a conflict between two private skills describes how a customer disagrees with itself",
      );

      const indexes = await owner.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where tablename = 'skill_relations'`,
      );
      check(
        "one edge per ordered pair per kind",
        indexes.rows.some(
          (r) =>
            /UNIQUE/.test(r.indexdef) &&
            /from_skill_id/.test(r.indexdef) &&
            /to_skill_id/.test(r.indexdef) &&
            /kind/.test(r.indexdef),
        ),
      );

      const two = (
        await owner.query<{ id: string; slug: string }>(
          `select id, slug from skills where status = 'indexed' and org_id is null limit 2`,
        )
      ).rows;

      if (two.length < 2) {
        skip("edge checks", "need two indexed public skills");
      } else {
        const { declareRelation, writeEdge, relationsFor, conflictsFor } = await import(
          "../src/server/analytics/relations"
        );

        /* The derived kinds must be refused with a message that names the real home. */
        const refusedSimilar = await declareRelation({
          fromSkillId: two[0].id,
          toSkillId: two[1].id,
          kind: "similar-to",
          orgId: null,
          userId: null,
        });
        check(
          "declaring similarity is refused",
          !refusedSimilar.ok && /embedding index/i.test(refusedSimilar.message),
          refusedSimilar.ok ? "accepted" : refusedSimilar.message,
        );

        const refusedSelf = await declareRelation({
          fromSkillId: two[0].id,
          toSkillId: two[0].id,
          kind: "requires",
          orgId: null,
          userId: null,
        });
        check("and a skill cannot relate to itself", !refusedSelf.ok);

        /*
         * A symmetric edge written once must be readable from both ends. This is the check that
         * would have caught a one-sided conflict, which is invisible from either page alone.
         */
        await writeEdge(
          {
            fromSkillId: two[0].id,
            toSkillId: two[1].id,
            kind: "conflicts-with",
            orgId: null,
            userId: null,
            detail: PROBE_DETAIL,
          },
          "mined",
          CONFLICT_MINER_VERSION,
        );

        const fromA = await conflictsFor(two[0].id);
        const fromB = await conflictsFor(two[1].id);
        check(
          "a mined conflict is visible from both skills",
          fromA.some((r) => r.detail === PROBE_DETAIL) &&
            fromB.some((r) => r.detail === PROBE_DETAIL),
          "a one-sided conflict would warn half the callers it should",
        );

        const view = await relationsFor(two[0].id, { similarLimit: 3 });
        check(
          "the reader separates conflicts from navigation",
          view.conflicts.some((r) => r.detail === PROBE_DETAIL) &&
            !view.relations.some((r) => r.kind === "conflicts-with"),
          `${view.relations.length} related, ${view.conflicts.length} conflicting`,
        );
        /*
         * Similarity must arrive from the live lookup rather than the table. If the vectors are
         * absent this is legitimately empty, so it is reported rather than asserted.
         */
        const similar = view.relations.filter((r) => r.kind === "similar-to");
        if (similar.length === 0) {
          skip("live similarity", "no embedding for this skill to resolve neighbours from");
        } else {
          check(
            "similarity is resolved live and carries a score",
            similar.every((r) => r.similarity !== null && r.similarity > 0),
            `${similar.length} neighbour(s), nearest ${similar[0].similarity}`,
          );
        }

        /* The miner, with a mock that reports one conflict. */
        const { mineConflictsWithModel } = await import("../src/server/analytics/conflicts");
        const mock = new MockLanguageModelV4({
          doGenerate: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  conflicts: [
                    { left: "Always squash merge.", right: "Never squash merge.", why: "It cannot do both." },
                  ],
                }),
              },
            ],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 40, text: 40, reasoning: 0 },
            },
            warnings: [],
          },
        });

        const report = await mineConflictsWithModel({ limit: 3 }, mock, "anthropic/claude-haiku-4.5");
        check(
          "the miner runs and reports what it filtered",
          report.pairsConsidered >= report.pairsCalled,
          `${report.pairsConsidered} considered, ${report.pairsCalled} called, ` +
            `${report.conflictsFound} found`,
        );
        if (report.pairsCalled === 0) {
          skip(
            "mined conflict rows",
            "no pair cleared the similarity, guardrail and shared-term filters",
          );
        } else {
          check("and meters what it spent", report.costMicros > 0, `${report.costMicros} micros`);
        }
      }
    }
  } finally {
    if (tableExists) {
      await owner.query(`delete from skill_relations where detail = $1`, [PROBE_DETAIL]);
      await owner.query(
        `delete from skill_relations where source = 'mined' and miner_version = $1
           and detail like '%It cannot do both%'`,
        [CONFLICT_MINER_VERSION],
      );
      await owner.query(`delete from llm_usage where subject_type = 'skill_relations'`);
    }
    await owner.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------
console.info("\nCan the detector fire at all?");
// ---------------------------------------------------------------------------------------

/**
 * The positive control, against a real model. Opt in with `--live`; costs about a fifth of a cent.
 *
 * ## Why this exists
 *
 * The first real mine returned **0 conflicts across 13 pairs**. That is either an honest finding —
 * conflicts should be rare — or a detector that cannot fire, and **nothing in this suite could
 * tell those apart**, because every other check here mocks the model and therefore tests
 * everything except whether the prompt works.
 *
 * ## Both directions, because one proves nothing
 *
 * A detector that answers "conflict" to every pair passes a positive-only test, and one that
 * answers "no" to everything passes a negative-only test. The prompt spends most of its length
 * suppressing false positives, which makes over-suppression the likely failure — so the pair of
 * checks is the evidence, not either one.
 */
if (process.argv.includes("--live")) {
  const { compareGuardrails } = await import("../src/server/analytics/conflicts");
  const { MODEL_DEFAULTS } = await import("../src/lib/models");
  const model = MODEL_DEFAULTS.evalJudge;

  const contradiction = await compareGuardrails(
    { name: "squash-merge", guardrails: ["Always squash commits into one before merging to main."] },
    {
      name: "preserve-history",
      guardrails: ["Never squash commits when merging; every individual commit must be preserved."],
    },
    model,
  );
  check(
    "a plain contradiction is reported",
    contradiction.output.conflicts.length >= 1,
    contradiction.output.conflicts[0]?.why ?? "nothing reported",
  );

  const unrelated = await compareGuardrails(
    { name: "squash-merge", guardrails: ["Always squash commits into one before merging to main."] },
    { name: "test-first", guardrails: ["Never deploy without running the full test suite."] },
    model,
  );
  check(
    "and two rules about different things are not",
    unrelated.output.conflicts.length === 0,
    unrelated.output.conflicts[0]?.why ?? "correctly silent",
  );

  /*
   * The case the prompt spends the most words on. A stricter rule that still satisfies the looser
   * one is the commonest false positive, and reporting it would fill the panel with pairs nobody
   * can act on.
   */
  const stricter = await compareGuardrails(
    { name: "review-one", guardrails: ["Every change must have at least one reviewer."] },
    { name: "review-two", guardrails: ["Every change must have at least two reviewers."] },
    model,
  );
  check(
    "and a stricter rule that still satisfies the looser one is not",
    stricter.output.conflicts.length === 0,
    stricter.output.conflicts[0]?.why ?? "correctly silent",
  );
} else {
  skip(
    "the detector's positive control",
    "three real model calls, about $0.002 — re-run with --live",
  );
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
