import "dotenv/config";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { BLOCK_TYPES } from "../src/lib/block-types";
import {
  clampDepth,
  diffDraftBlocks,
  DRAFT_BLOCK_FORMS,
  MAX_HEADING_DEPTH,
  renderDraftBlock,
  renderDraftBody,
  REVISION_REASONS,
  summariseChanges,
  type DraftBlock,
} from "../src/lib/draft-blocks";
import { headingSpans } from "../src/server/analytics/blocks";
import { extractStructure } from "../src/server/analytics/structure";
import { tileDraftBody } from "../src/server/builder/blocks";

/**
 * A draft is typed blocks, and the body is their render (plan step C1).
 *
 *   pnpm verify:draft-blocks
 *
 * Free. No model, no network; the schema half reads two catalogue tables and writes nothing.
 *
 * ## What is actually at risk
 *
 * Not the storage — a table with ten columns is hard to get wrong. Three things:
 *
 *   1. **Reassembly that silently loses content.** The corpus extractor treats a heading as
 *      a *boundary*, not a block, and skips horizontal rules as punctuation. Both are right
 *      for measuring a corpus and fatal for storing a draft: concatenating its spans returns
 *      a document with every heading gone, and nothing errors — the author sees a document
 *      that is no longer theirs. This suite **reproduces that loss first**, then asserts the
 *      tiling repairs it, so the fixture is proven able to fail.
 *   2. **Two writable representations of one document.** The body is derived; if a second
 *      code path writes it, the two drift and the drift is invisible until somebody publishes
 *      a document they did not edit. Asserted against the source tree, because it is a
 *      property of the code and no amount of clean data can demonstrate it.
 *   3. **Types that move across a round trip.** An author retypes a passage, saves, and the
 *      re-render segments differently — so the archetype comparison beside their draft
 *      describes a document that differs from the one they are reading.
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

/**
 * Fixtures shaped like real skills, not like the happy path.
 *
 * Every one carries something the extractor deliberately does not emit as a block: a
 * heading, a horizontal rule, a `#` inside a fence, a nested list continuation. Those are the
 * only parts a tiling can lose, so a fixture without them cannot fail.
 */
const FIXTURES: Array<{ name: string; body: string }> = [
  {
    name: "headings, prose, ordered steps",
    body: `## When to use this

Use this skill when reviewing a Terraform plan before it is applied.

## Steps

1. Read the plan output in full.
2. Flag every destroy of a stateful resource.
3. Check that no provider version moved.

## Guardrails

- Never approve a plan that destroys a database.
- Always name the workspace in the summary.`,
  },
  {
    name: "a fence containing a markdown heading",
    body: `## Tool contract

Run the checker:

\`\`\`bash
# not a heading — this is a shell comment inside a fence
./scripts/check.sh --strict
\`\`\`

It prints one line per finding.`,
  },
  {
    name: "horizontal rules between sections",
    body: `# Overview

Something short.

---

## Details

More detail here.

---

## References

- [The spec](references/spec.md)`,
  },
  {
    name: "a loose list with indented continuations",
    body: `## Procedure

1. Open the file.

   It may be large; read only the header.

2. Apply the patch.

   Verify the checksum afterwards.`,
  },
  {
    name: "a table and a blockquote",
    body: `## Decision rule

| Case | Action |
|---|---|
| No tests | Ask for tests |
| Tests fail | Reject |

> Note: a reject is not a rewrite request.`,
  },
  {
    name: "no headings at all",
    body: `You are reviewing infrastructure changes.

Always read the whole diff before commenting.`,
  },
  {
    name: "deep headings and trailing whitespace",
    body: `###### Appendix

Terms used above.

- **plan** — the output of \`terraform plan\`.`,
  },
];

/** Non-blank, so whitespace normalisation is allowed and content loss is not. */
function meaningfulLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------------------
console.info("\nThe failure this step exists to prevent");
// ---------------------------------------------------------------------------------------

/**
 * The naive reassembly, reproduced before anything is asserted about the fix.
 *
 * `blockDeviations` already runs `extractStructure` over a draft body and types it, and the
 * plan is right that no *new detector* is needed. What is easy to miss — and what this check
 * exists to keep visible — is that the extractor's spans do not cover the document. If this
 * check ever goes green, the extractor has started emitting headings, and the tiling below is
 * either redundant or double-counting them.
 */
{
  const fixture = FIXTURES[0];
  const naive = extractStructure({
    body: fixture.body,
    frontmatter: {},
    files: [{ path: "SKILL.md", content: Buffer.from(fixture.body, "utf8") }],
    markerPath: "SKILL.md",
  })
    .blocks.map((b) => fixture.body.slice(b.startChar, b.endChar))
    .join("\n\n");

  const headings = headingSpans(fixture.body);
  const lost = headings.filter((h) => !naive.includes(`# ${h.text}`));

  check(
    "concatenating the extractor's own spans loses every heading",
    headings.length > 0 && lost.length === headings.length,
    `${lost.length} of ${headings.length} headings absent from the naive reassembly`,
  );

  const rules = (fixture.body.match(/^---$/gm) ?? []).length;
  const hrBody = FIXTURES[2].body;
  const naiveHr = extractStructure({
    body: hrBody,
    frontmatter: {},
    files: [{ path: "SKILL.md", content: Buffer.from(hrBody, "utf8") }],
    markerPath: "SKILL.md",
  })
    .blocks.map((b) => hrBody.slice(b.startChar, b.endChar))
    .join("\n\n");
  check(
    "and loses horizontal rules, which it skips as punctuation",
    !naiveHr.includes("---") && (hrBody.match(/^---$/gm) ?? []).length === 2,
    `${rules === 0 ? "2" : String(rules)} rules in the source, none in the reassembly`,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe tiling reassembles the document");
// ---------------------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  const blocks = tileDraftBody(fixture.body);
  const rendered = renderDraftBody(blocks);

  const before = meaningfulLines(fixture.body);
  const after = meaningfulLines(rendered);
  const same = before.length === after.length && before.every((line, i) => line === after[i]);
  check(
    `every non-blank line survives, in order — ${fixture.name}`,
    same,
    same
      ? `${before.length} lines, ${blocks.length} blocks`
      : `${before.length} lines in, ${after.length} out; first difference at ${
          before.findIndex((line, i) => line !== after[i]) + 1
        }`,
  );

  /*
   * Idempotence is the property that makes the body safe to store.
   *
   * A save renders from blocks; the next edit re-imports what is on screen. If the second
   * round trip moved the document, a draft nobody touched would change every time it was
   * opened, and the diff an author reviewed would not be the diff they made.
   */
  const twice = renderDraftBody(tileDraftBody(rendered));
  check(
    `re-importing the render is a no-op — ${fixture.name}`,
    twice === rendered,
    twice === rendered ? "" : `${rendered.length} → ${twice.length} chars`,
  );

  /*
   * Types stable across the round trip. The archetype comparison on the draft page runs
   * `extractStructure` over the rendered body, so if the render segments differently from
   * the blocks it came from, the panel describes a document the author is not reading.
   */
  const storedTypes = blocks
    .filter((b) => b.form === "content" && b.type)
    .map((b) => b.type)
    .sort();
  const rerunTypes = extractStructure({
    body: rendered,
    frontmatter: {},
    files: [{ path: "SKILL.md", content: Buffer.from(rendered, "utf8") }],
    markerPath: "SKILL.md",
  })
    .blocks.map((b) => b.type)
    .filter(Boolean)
    .sort();
  check(
    `the render re-types to what was stored — ${fixture.name}`,
    storedTypes.length === rerunTypes.length &&
      storedTypes.every((t, i) => t === rerunTypes[i]),
    `${storedTypes.length} typed blocks`,
  );
}

{
  const fenced = tileDraftBody(FIXTURES[1].body);
  check(
    "a `#` inside a code fence is not read as a heading",
    fenced.every((b) => b.form !== "heading" || !b.text.includes("not a heading")),
    `${fenced.filter((b) => b.form === "heading").length} heading blocks`,
  );

  const ruled = tileDraftBody(FIXTURES[2].body);
  check(
    "a horizontal rule survives as an untyped block rather than being deleted",
    ruled.filter((b) => b.form === "content" && b.type === null && b.text.trim() === "---")
      .length === 2,
    "two rules kept",
  );

  const depths = tileDraftBody(FIXTURES[6].body).filter((b) => b.form === "heading");
  check(
    "heading depth is carried through, not flattened",
    depths.length === 1 && depths[0].depth === 6,
    `depth ${depths[0]?.depth}`,
  );

  check("an empty body tiles to nothing", tileDraftBody("").length === 0);
  check("and renders to the empty string", renderDraftBody([]) === "");
}

// ---------------------------------------------------------------------------------------
console.info("\nThe renderer");
// ---------------------------------------------------------------------------------------

check(
  "heading depth is clamped to the markdown range",
  clampDepth(0) === 1 && clampDepth(99) === MAX_HEADING_DEPTH && clampDepth(null) === 2,
  `0→${clampDepth(0)}, 99→${clampDepth(99)}, null→${clampDepth(null)}`,
);

check(
  "a heading renders from its depth and label, not from stored `#` marks",
  renderDraftBlock({ form: "heading", depth: 3, text: "  When to use this  " }) ===
    "### When to use this",
);

/*
 * An empty block must vanish rather than leave a hole.
 *
 * C1b's "add one here" inserts an empty typed block on purpose — the alternative was pasting
 * somebody's attribution-required paragraph into the draft. An author who adds three and
 * fills in one should get one new passage, not one passage and two blank-line runs that the
 * structural lint would then flag.
 */
check(
  "an empty block renders to nothing and leaves no gap",
  renderDraftBody([
    { form: "content", depth: null, text: "First." },
    { form: "content", depth: null, text: "   " },
    { form: "content", depth: null, text: "Second." },
  ]) === "First.\n\nSecond.",
);

check(
  "leading whitespace is preserved — it is load-bearing in markdown",
  renderDraftBlock({ form: "content", depth: null, text: "   continuation of the item above" }) ===
    "   continuation of the item above",
);

check(
  "trailing whitespace is removed, so the join is exactly one blank line",
  renderDraftBody([
    { form: "content", depth: null, text: "One.\n\n\n" },
    { form: "content", depth: null, text: "Two." },
  ]) === "One.\n\nTwo.",
);

check(
  "the two forms are the whole vocabulary",
  DRAFT_BLOCK_FORMS.length === 2 &&
    DRAFT_BLOCK_FORMS.includes("heading") &&
    DRAFT_BLOCK_FORMS.includes("content"),
  DRAFT_BLOCK_FORMS.join(", "),
);

check(
  "the block types are imported, not redeclared",
  BLOCK_TYPES.length === 11,
  `${BLOCK_TYPES.length} types from block-types.ts`,
);

// ---------------------------------------------------------------------------------------
console.info("\nThe revision diff (R4.7)");
// ---------------------------------------------------------------------------------------

/**
 * The failure R4.7 was blocked on, reproduced before the fix is asserted.
 *
 * A revision over a body string is a character diff, and the specific thing it cannot express
 * is a **move**: a block relocated shows up as a deletion and an unrelated insertion far away.
 * So the first check here is that the naive comparison — text in, text out — reports a
 * document as wholly rewritten when a single block moved and nothing was edited.
 */
{
  const block = (id: string, order: number, text: string): DraftBlock => ({
    id,
    order,
    form: "content",
    depth: null,
    type: null,
    text,
  });

  const before = [block("a", 0, "First."), block("b", 1, "Second."), block("c", 2, "Third.")];
  const moved = [block("c", 0, "Third."), block("a", 1, "First."), block("b", 2, "Second.")];

  const naiveLines = (blocks: DraftBlock[]) => blocks.map((b) => b.text);
  const naiveChanged = naiveLines(before).filter((line, i) => line !== naiveLines(moved)[i]);
  check(
    "comparing rendered text calls a single move a whole-document rewrite",
    naiveChanged.length === 3,
    `${naiveChanged.length} of 3 lines differ, though nothing was written`,
  );

  const changes = diffDraftBlocks(before, moved);
  check(
    "matching on id reports it as moves and nothing else",
    changes.length === 3 && changes.every((c) => c.kind === "moved"),
    summariseChanges(changes),
  );

  const edited = [block("a", 0, "First, revised."), block("b", 1, "Second."), block("c", 2, "Third.")];
  const editChanges = diffDraftBlocks(before, edited);
  check(
    "a rewritten block is one edit, not an add and a remove",
    editChanges.length === 1 && editChanges[0].kind === "edited",
    summariseChanges(editChanges),
  );

  const retyped = [
    { ...before[0], type: "guardrail" as const },
    before[1],
    before[2],
  ];
  const retypeChanges = diffDraftBlocks(before, retyped);
  check(
    "a retype is distinguished from a rewrite",
    retypeChanges.length === 1 &&
      retypeChanges[0].kind === "edited" &&
      retypeChanges[0].retyped,
    summariseChanges(retypeChanges),
  );

  /*
   * A block both rewritten and moved is one change, not two. Counting it twice would inflate
   * every line of a history list for no information — the position is on the row either way.
   */
  const both = [block("b", 0, "Second."), block("a", 1, "First, revised."), block("c", 2, "Third.")];
  const bothChanges = diffDraftBlocks(before, both);
  check(
    "a block that was rewritten and moved counts once",
    bothChanges.filter(
      (c) => ("to" in c && c.to.id === "a") || ("from" in c && c.from.id === "a"),
    ).length === 1,
    summariseChanges(bothChanges),
  );

  check(
    "an unchanged list produces no changes, so a no-op save writes no revision",
    diffDraftBlocks(before, before).length === 0,
  );

  const removed = diffDraftBlocks(before, [before[0], before[2]]);
  check(
    "a deleted block is reported as removed",
    removed.length === 1 && removed[0].kind === "removed",
    summariseChanges(removed),
  );

  /*
   * Named rather than counted. The first version asserted a length, which meant adding a
   * fifth reason turned this red for no reason anybody cared about — a check that fails on a
   * legitimate change teaches people to edit checks rather than read them.
   */
  check(
    "the reason vocabulary distinguishes the model, a person, and a restore",
    (["generated", "scaffolded", "edited", "restored"] as const).every((reason) =>
      (REVISION_REASONS as readonly string[]).includes(reason),
    ),
    REVISION_REASONS.join(", "),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe body has exactly one writer");
// ---------------------------------------------------------------------------------------

/**
 * A source-tree assertion, and it has to be.
 *
 * "The blocks are the source and the body is a render" is only true while one code path
 * writes the column. Clean data proves nothing about that — a second writer produces a body
 * that renders differently from the blocks beside it and nothing errors, exactly as
 * `verify:dedup` stayed green through an ingestion outage by asserting the data was tidy
 * instead of attempting the insert that caused the bug.
 *
 * So this reads the tree. It is deliberately a whitelist of one file: adding a writer means
 * changing this check, and changing this check means reading the paragraph above it.
 */
{
  const roots = ["src", "scripts"];
  const ALLOWED = new Set(["src/server/builder/blocks.ts"]);
  const writers: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      const source = readFileSync(path, "utf8");
      if (!source.includes("skillDrafts")) continue;
      /*
       * A `.set({ … body: … })` on an update, in any formatting. Deliberately crude: the
       * failure mode of a grep that cannot see its target is documented twice in CLAUDE.md
       * — the `aws4fetch` method-shaped `fetch` that stayed unguarded — so this matches the
       * property name at the start of a line inside a `.set(` call and accepts false
       * positives, which are visible, over false negatives, which are not.
       */
      for (const setCall of source.match(/\.set\(\{[\s\S]{0,2000}?\}\)/g) ?? []) {
        if (/^\s*body:/m.test(setCall)) writers.push(path);
      }
    }
  };
  for (const root of roots) walk(root);

  const unexpected = [...new Set(writers)].filter((path) => !ALLOWED.has(path));
  check(
    "only the block writer sets skill_drafts.body",
    unexpected.length === 0,
    unexpected.length === 0
      ? [...ALLOWED].join(", ")
      : `also written by ${unexpected.join(", ")}`,
  );

  /*
   * And the check is proven able to fire. A whitelist that matched nothing at all would pass
   * for the wrong reason — the exact shape of `verify:embeddings`' `hits.length === 0 ||
   * coveragePercent === coverage`, whose right-hand side could not fail.
   */
  check(
    "and that writer is found by this search, so an empty result is not a pass",
    [...new Set(writers)].some((path) => ALLOWED.has(path)),
    `${new Set(writers).size} writer(s) matched`,
  );
}

/**
 * A scaffold is not a publishable draft.
 *
 * R4.6's path creates a document of headings and empty typed blocks, which is a body — so
 * `if (!draft.body)` passes on an outline nobody wrote into. The gate is the status, and the
 * status is set from *content*: the check reads both sides so a change to either shows up
 * here rather than as an empty skill in somebody's workspace.
 */
{
  const writer = readFileSync("src/server/builder/blocks.ts", "utf8");
  check(
    "`ready` is decided on a content block with text in it, not on a body existing",
    /status: normalised\.some\(\(block\) => block\.form === "content" && block\.text\.trim\(\)\)/.test(
      writer,
    ),
    "the block writer sets it",
  );
  const publish = readFileSync("src/server/builder/publish.ts", "utf8");
  check(
    "and publishing refuses anything that is not ready",
    /draft\.status !== "ready"/.test(publish),
    "checked server-side, where a POST endpoint cannot route around it",
  );
}

/**
 * Publish and export must not learn about blocks.
 *
 * R6.1 is true because publish-back hands a body to the same validator a sync uses, and R4.4
 * is true because export hands a body to the same archive builder. A block-aware version of
 * either would be a second definition of "servable", and it would drift on the axis where
 * drift is a legal problem rather than a bug.
 */
{
  for (const path of ["src/server/builder/publish.ts", "src/server/builder/export.ts"]) {
    const source = readFileSync(path, "utf8");
    check(
      `${path.split("/").pop()} takes a body and knows nothing about blocks`,
      !/draftBlocks|draft-blocks|getDraftBlocks|tileDraftBody/.test(source),
      "no block import",
    );
  }
}

// ---------------------------------------------------------------------------------------
console.info("\nThe table");
// ---------------------------------------------------------------------------------------

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  skip("schema checks", "no database connection — the checks above are complete without it");
}

if (connected) {
  try {
    const exists = await c.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public' and table_name = 'draft_blocks'`,
    );
    if (exists.rows[0].n === "0") {
      skip(
        "draft_blocks",
        "the table does not exist yet — apply migrations/0031, then re-run",
      );
    } else {
      const policies = await c.query<{ policyname: string; qual: string; with_check: string }>(
        `select policyname, qual, with_check from pg_policies
          where tablename = 'draft_blocks'`,
      );
      check(
        "row-level security is declared on the table",
        policies.rowCount === 1,
        `${policies.rowCount} policy`,
      );

      /*
       * No `org_id is null` escape hatch, and the absence is the point.
       *
       * Every corpus table admits public rows that way. There is no such thing as a public
       * draft, so there is no such thing as a public draft block — an unauthenticated request
       * sets no `app.org_id`, `current_setting` returns NULL, and the comparison yields NULL
       * rather than true. A copied-in clause from a corpus table would silently expose every
       * workspace's unpublished writing.
       */
      const qual = policies.rows[0]?.qual ?? "";
      check(
        "and it has no public escape hatch, matching skill_drafts",
        qual.length > 0 && !/is null/i.test(qual),
        qual.slice(0, 80),
      );

      const rls = await c.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = 'draft_blocks'`,
      );
      check("and it is enabled, not merely declared", rls.rows[0]?.relrowsecurity === true);

      const indexes = await c.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where tablename = 'draft_blocks'`,
      );
      check(
        "block_order is unique within a draft",
        indexes.rows.some(
          (r) => /UNIQUE/.test(r.indexdef) && /draft_id/.test(r.indexdef) && /block_order/.test(r.indexdef),
        ),
        `${indexes.rowCount} indexes`,
      );

      /*
       * One index on those two columns, not two.
       *
       * The unique index is also the ordered read path. A second plain btree on the same
       * columns in the same order costs a write on every save and is never chosen — the kind
       * of thing that is obvious in a generated migration and invisible a month later.
       */
      const onPair = indexes.rows.filter(
        (r) => /\(draft_id, block_order\)/.test(r.indexdef.replace(/"/g, "")),
      );
      check("and only one index covers that pair", onPair.length === 1, `${onPair.length}`);

      const cols = await c.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_name = 'draft_blocks'`,
      );
      const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
      check(
        "org_id is NOT NULL, so a row cannot escape its tenant",
        byName.get("org_id") === "NO",
      );
      check(
        "type is nullable — an unlabelled passage is content, not a defect",
        byName.get("type") === "YES",
      );
      check(
        "text is NOT NULL — a block with no content is not stored, it is dropped on render",
        byName.get("text") === "NO",
      );

      const revExists = await c.query<{ n: string }>(
        `select count(*)::text as n from information_schema.tables
          where table_schema = 'public' and table_name = 'draft_revisions'`,
      );
      if (revExists.rows[0].n === "0") {
        skip("draft_revisions", "the table does not exist yet — apply migrations/0031");
      } else {
        const revPolicies = await c.query<{ cmd: string; qual: string | null }>(
          `select cmd, qual from pg_policies where tablename = 'draft_revisions'`,
        );
        const commands = new Set(revPolicies.rows.map((r) => r.cmd));
        check(
          "history can be read and appended to",
          commands.has("SELECT") && commands.has("INSERT"),
          [...commands].join(", "),
        );
        /*
         * The absence is the assertion. A revision the application can rewrite or remove is
         * not a revision — same posture as `llm_usage`, whose no-DELETE policy is what makes
         * the spend ledger an audit trail rather than a running total.
         */
        check(
          "and neither updated nor deleted — history the app can rewrite is not history",
          !commands.has("UPDATE") && !commands.has("DELETE") && !commands.has("ALL"),
          [...commands].join(", ") || "none",
        );
        check(
          "no public escape hatch on the history either",
          revPolicies.rows.every((r) => !r.qual || !/is null/i.test(r.qual)),
        );

        const revIdx = await c.query<{ indexdef: string }>(
          `select indexdef from pg_indexes where tablename = 'draft_revisions'`,
        );
        check(
          "revision numbers are unique within a draft",
          revIdx.rows.some(
            (r) => /UNIQUE/.test(r.indexdef) && /draft_id/.test(r.indexdef) && /revision/.test(r.indexdef),
          ),
        );

        const revCols = await c.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_name = 'draft_revisions'`,
        );
        /*
         * The body is deliberately absent from the snapshot. A revision is a set of blocks and
         * the body is what the renderer makes of them; storing both would reintroduce inside
         * the history the exact drift the live table was designed to prevent.
         */
        check(
          "a revision stores blocks and not a rendered body",
          !revCols.rows.some((r) => r.column_name === "body"),
          revCols.rows.map((r) => r.column_name).join(", "),
        );
      }
    }
  } finally {
    await c.end().catch(() => undefined);
  }
}

console.info(
  `\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`,
);
process.exit(fail > 0 ? 1 : 0);
