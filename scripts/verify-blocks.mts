import "dotenv/config";

import { Client } from "pg";

import { BLOCK_KINDS, BLOCK_TYPES, BLOCK_TYPE_META } from "../src/lib/block-types";
import {
  BLOCK_RULES,
  blockCountsOf,
  blockTypesOf,
  extractBlocks,
  type SkillBlock,
} from "../src/server/analytics/blocks";
import {
  EXTRACTOR_VERSION,
  extractStructure,
  SECTION_ROLES,
} from "../src/server/analytics/structure";

/**
 * Block segmentation and typing hold their invariants (Doc 6 RW.1).
 *
 *   pnpm verify:blocks
 *
 * Free. The detector half calls no model, no network and no database; the stored-row half
 * reads two tables and writes nothing.
 *
 * ## Written failure-first, because a detector is the easiest thing to verify weakly
 *
 * A check that walks the corpus and reports "94% of blocks got a type" tells you nothing
 * about whether the types are *right*, and it goes green on a detector that labels
 * everything `guardrail`. This project has been burned twice by exactly that shape — a grep
 * that structurally could not see the call sites it was meant to guard, and a
 * unique-violation handler that matched nothing and was never run against a real 23505. So
 * every case below states the wrong answer it is guarding against, and where the wrong
 * answer is what a plausible implementation would give, the fixture proves the trap is
 * still armed before asserting the fix.
 *
 * The three invariants that matter more than any single classification:
 *
 *   1. **Spans are exact and lossless.** Every non-blank, non-heading line lands in exactly
 *      one block. A detector that silently drops content produces a block library with
 *      holes and nobody would notice.
 *   2. **No text is stored.** A block row is a coordinate plus counters. This is the R1.6
 *      guarantee that lets the library cover a `metadata_only` skill at all, so it is
 *      asserted against a marker phrase rather than assumed from reading the type.
 *   3. **Unclassified is reachable.** Doc 6 §7 names over-structuring as this programme's
 *      risk. A taxonomy that types every passage is not succeeding, it is guessing.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Runs the real path: fingerprint first (for the heading tree), then blocks. */
function blocksOf(body: string, files: Array<{ path: string }> = [{ path: "SKILL.md" }]) {
  const fingerprint = extractStructure({
    files: files.map((f) => ({ path: f.path, content: Buffer.from("") })) as never,
    body,
    frontmatter: {},
    markerPath: "SKILL.md",
  });
  const blocks = extractBlocks({
    body,
    headings: fingerprint.headings,
    bundlePaths: new Set(files.map((f) => f.path)),
  });
  return { fingerprint, blocks };
}

const firstOfType = (blocks: SkillBlock[], type: string) => blocks.find((b) => b.type === type);

console.info("\nBlock taxonomy — vocabulary");

check(
  "every block type carries a label, a blurb and a quality signal",
  BLOCK_TYPES.every(
    (t) =>
      BLOCK_TYPE_META[t]?.label?.length > 0 &&
      BLOCK_TYPE_META[t]?.blurb?.length > 0 &&
      BLOCK_TYPE_META[t]?.signal?.length > 0,
  ),
  `${BLOCK_TYPES.length} types`,
);

check("the taxonomy is the eleven types Doc 6 RW.1 defines", BLOCK_TYPES.length === 11, `${BLOCK_TYPES.length}`);

// ---------------------------------------------------------------------------------------
console.info("\nStructure beats lexicon — the ordering bug, reproduced then fixed");
// ---------------------------------------------------------------------------------------

/**
 * The trap: procedures are written in modal verbs. A lexical guardrail rule placed above
 * the ordered-list rule types every numbered procedure in the corpus as a guardrail, and
 * the resulting archetype tells authors that good skills in every category are made of
 * guardrails. Measured on the first pass of this detector: it did exactly that.
 */
const procedureWithModals = `## Steps

1. Run the dry run first. You must never skip it.
2. Read the generated SQL. Always check for a phantom drop.
3. Apply the migration.
`;

{
  const { blocks } = blocksOf(procedureWithModals);
  const list = blocks.find((b) => b.features.kind === "list");

  // First prove the trap is armed: the guardrail cue really does fire on this text, so the
  // only thing standing between it and a wrong answer is the rule order.
  check(
    "the guardrail cue fires on the numbered procedure (the trap is armed)",
    list?.features.hasModal === true,
    list?.features.hasModal === true ? "must/never present" : "fixture no longer reproduces",
  );
  check(
    "a numbered list of modal steps is a procedure, not a guardrail",
    list?.type === "procedure",
    `got ${list?.type} via ${list?.rule}`,
  );
}

{
  // The mirror case, which is what stops the fix from being "call everything a procedure".
  const { blocks } = blocksOf(`## Rules

- Never commit secrets to the repository.
- Do not disable the pre-commit hook.
- Credentials must come from the environment.
`);
  const list = blocks.find((b) => b.features.kind === "list");
  check(
    "an unordered list of prohibitions is a guardrail, not a procedure",
    list?.type === "guardrail",
    `got ${list?.type} via ${list?.rule}`,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nSpans are exact and lossless");
// ---------------------------------------------------------------------------------------

const richBody = `Some preamble prose about XYZZY-SECRET-PHRASE and what this does.

## When to use this

Use this skill when the user asks for a database migration review.

## Steps

1. Read the schema diff.
2. Check the generated SQL.

## Rules

- Never run drizzle-kit push.
- Always read the SQL before applying it.

## Examples

Input: a migration adding a partial index.
Output: a review naming the phantom-drop risk.

\`\`\`bash
pnpm db:generate
\`\`\`

## Output format

Return a markdown table with one row per finding.

## References

- [The migration guide](references/migrations.md)
- [Drizzle docs](https://orm.drizzle.team)
`;

{
  const { blocks } = blocksOf(richBody, [
    { path: "SKILL.md" },
    { path: "references/migrations.md" },
  ]);

  // 1. Ordered, non-overlapping.
  let ordered = true;
  for (let i = 1; i < blocks.length; i += 1) {
    if (blocks[i].startChar < blocks[i - 1].endChar) ordered = false;
  }
  check("spans are ordered and never overlap", ordered, `${blocks.length} blocks`);

  // 2. Exact: the slice equals the segment, and one character less does not. The second
  // half is what catches an off-by-one that a "slice is non-empty" check would pass.
  const exact = blocks.every((b) => {
    const slice = richBody.slice(b.startChar, b.endChar);
    return slice.trim().length > 0 && slice === slice.trimEnd() ? true : slice.trim().length > 0;
  });
  const noTrailingNewline = blocks.every((b) => !richBody.slice(b.startChar, b.endChar).endsWith("\n"));
  check("every span slices to non-empty content", exact);
  check("no span includes its trailing newline (off-by-one guard)", noTrailingNewline);

  // 3. Lossless: every line that is not blank and not a heading is inside a block.
  const covered = new Set<number>();
  for (const b of blocks) {
    for (let pos = b.startChar; pos < b.endChar; pos += 1) covered.add(pos);
  }
  let uncoveredLines = 0;
  let offset = 0;
  for (const line of richBody.split("\n")) {
    const trimmed = line.trim();
    const isHeading = /^#{1,6}\s/.test(trimmed);
    if (trimmed.length > 0 && !isHeading) {
      const start = offset + (line.length - line.trimStart().length);
      if (!covered.has(start)) uncoveredLines += 1;
    }
    offset += line.length + 1;
  }
  check("every non-blank, non-heading line lands in a block", uncoveredLines === 0, `${uncoveredLines} lines dropped`);

  // 4. No text stored. The marker phrase is in the body's first paragraph, so a block that
  // carried content would serialise it.
  const serialised = JSON.stringify(blocks);
  check(
    "no block carries body text (R1.6 — the library must not mirror content)",
    !serialised.includes("XYZZY-SECRET-PHRASE") && !serialised.includes("drizzle-kit push"),
  );

  // 5. Section attribution agrees with the heading tree rather than re-deriving it.
  const { fingerprint } = blocksOf(richBody);
  const validOrders = new Set(fingerprint.headings.map((h) => h.order));
  check(
    "every parent heading order exists in the fingerprint's heading tree",
    blocks.every((b) => b.parentHeadingOrder === null || validOrders.has(b.parentHeadingOrder)),
  );
  check(
    "the preamble above the first heading has no parent role",
    blocks[0]?.parentRole === null && blocks[0]?.parentHeadingOrder === null,
    `got ${blocks[0]?.parentRole}`,
  );

  // 6. The denormalised aggregation path agrees with the detail.
  const counts = blockCountsOf(blocks);
  const types = blockTypesOf(blocks);
  const countsAgree = Object.entries(counts).every(([type, n]) =>
    type === "unclassified"
      ? blocks.filter((b) => b.type === null).length === n
      : blocks.filter((b) => b.type === type).length === n,
  );
  check("blockCounts agrees with the block list", countsAgree, JSON.stringify(counts));
  check(
    "blockTypes is exactly the distinct classified types",
    types.length === new Set(blocks.filter((b) => b.type).map((b) => b.type)).size,
    types.join(", "),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nEach type is reachable on realistic input");
// ---------------------------------------------------------------------------------------

{
  const cases: Array<{ type: string; body: string; note: string }> = [
    {
      type: "trigger",
      note: "a when-to-use section",
      body: "## When to use this\n\nReach for this when reviewing a Terraform plan.\n",
    },
    {
      type: "stance",
      note: "a persona line at the top",
      body: "You are an experienced database reviewer working on a production schema.\n",
    },
    {
      type: "decision-rule",
      note: "a conditional with a consequent",
      body: "## Guidance\n\nIf the migration touches a hot table, then use a concurrent index. Otherwise apply it inline.\n",
    },
    {
      type: "decision-rule",
      note: "a decision table",
      body: "## Guidance\n\n| Condition | Action |\n|---|---|\n| Hot table | Concurrent index |\n| Cold table | Inline |\n",
    },
    {
      type: "anti-example",
      note: "an explicit bad-case marker",
      body: "## Guidance\n\n❌ Wrong: applying the migration without reading the generated SQL.\n",
    },
    {
      type: "anti-example",
      note: "a common-mistakes heading",
      body: "## Common mistakes\n\nAuthors reach for a broad grep and conclude the call site is guarded.\n",
    },
    {
      type: "tool-contract",
      note: "a shell fence",
      body: "## Usage\n\n```bash\npnpm db:generate --name add_index\n```\n",
    },
    {
      type: "tool-contract",
      note: "a script invocation in prose",
      body: "## Usage\n\nRun scripts/extract.py to produce the report.\n",
    },
    {
      type: "output-spec",
      note: "an output-format section",
      body: "## Output format\n\nA markdown table, one row per finding, severity first.\n",
    },
    {
      type: "example",
      note: "an input/output pair",
      body: "## Walkthrough\n\nInput: a plan adding one resource.\nOutput: a one-line summary naming the resource.\n",
    },
    {
      type: "glossary",
      note: "a definition list",
      body: "## Concepts\n\n- **Phantom drop** — a proposed drop of an index that still exists.\n- **Pooled endpoint** — the connection host the app uses.\n",
    },
    {
      type: "glossary",
      note: "a term table",
      body: "## Terms\n\n| Term | Meaning |\n|---|---|\n| Lift | Strong minus weak prevalence |\n",
    },
    {
      type: "reference-pointer",
      note: "a link list",
      body: "## References\n\n- [Migrations](references/migrations.md)\n- [Schema](references/schema.md)\n",
    },
    {
      type: "guardrail",
      note: "a modal prohibition in prose",
      body: "## Constraints\n\nYou must never write to the production database from a test.\n",
    },
    {
      type: "procedure",
      note: "an ordered list",
      body: "## Steps\n\n1. Read the diff.\n2. Run the generator.\n3. Apply it.\n",
    },
  ];

  for (const c of cases) {
    const { blocks } = blocksOf(c.body);
    const hit = firstOfType(blocks, c.type);
    check(
      `${c.type} — ${c.note}`,
      hit !== undefined,
      hit ? `via ${hit.rule}` : `got ${blocks.map((b) => b.type ?? "null").join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------------------
console.info("\nThe taxonomy does not force a type onto everything");
// ---------------------------------------------------------------------------------------

{
  // A purely topical passage. Doc 6 §7: blocks are detected and suggested, never mandatory,
  // and a detector that types this is guessing rather than recognising.
  const { blocks } = blocksOf(
    "## Typography\n\nThe display face is a transitional serif at 42 points over a 16-point body.\n",
  );
  check(
    "a topical paragraph stays unclassified",
    blocks.length > 0 && blocks.every((b) => b.type === null),
    blocks.map((b) => `${b.type ?? "null"}${b.rule ? `/${b.rule}` : ""}`).join(", "),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nDialects and malformed input");
// ---------------------------------------------------------------------------------------

{
  // 121 AGENTS.md files in this corpus have no frontmatter and, often, no headings at all.
  // An extractor that needs a heading tree to find blocks makes a whole dialect invisible,
  // which is the exact bug structural-lint shipped with (see CLAUDE.md).
  const { blocks } = blocksOf(
    "Always run the linter before committing.\n\nNever push directly to master.\n",
  );
  check(
    "a body with no headings still yields blocks",
    blocks.length === 2 && blocks.every((b) => b.parentRole === null),
    `${blocks.length} blocks`,
  );
}

{
  // An unclosed fence is common in the corpus. It must not swallow the document silently
  // *or* throw: the run isolates per skill, but a crash here costs the whole slice's block
  // rows for that bundle.
  const { blocks } = blocksOf("## Usage\n\n```bash\npnpm dev\n\n## Notes\n\nSome prose.\n");
  check("an unclosed fence yields at least one block and does not throw", blocks.length >= 1, `${blocks.length} blocks`);
}

{
  // A loose list — blank lines between items — is one procedure, not one block per item.
  // The flag-based version of the segmenter split this into three.
  const { blocks } = blocksOf("## Steps\n\n1. First step.\n\n2. Second step.\n\n3. Third step.\n");
  const lists = blocks.filter((b) => b.features.kind === "list");
  check(
    "a loose numbered list is one block, not one per item",
    lists.length === 1 && lists[0].features.itemCount === 3,
    `${lists.length} list block(s), ${lists[0]?.features.itemCount} items`,
  );
}

{
  // Token estimate is per block and must be positive and roughly proportional. RW.9 will
  // replace the estimate with a measurement; until then it must not read as exact.
  const { blocks } = blocksOf(richBody);
  const total = blocks.reduce((sum, b) => sum + b.tokenEstimate, 0);
  check(
    "every block carries a positive token estimate",
    blocks.every((b) => b.tokenEstimate >= 1),
    `${total} tokens estimated across ${blocks.length} blocks`,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nStored rows");
// ---------------------------------------------------------------------------------------

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — detector checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.skill_blocks') is not null as present`,
  );

  if (!exists[0].present) {
    console.info("  skip  skill_blocks does not exist yet — apply the migration, then re-run");
  } else {
    /**
     * The column this table may never grow: one holding body text.
     *
     * A block row is a coordinate. The moment it carries text, the library mirrors content
     * and every `metadata_only` skill in it becomes a licence breach — the same shape as the
     * `builder_signals` read policy being safe *because of* its column list.
     *
     * ## Two halves, because the allowlist alone is the weak part
     *
     * The first version was an allowlist of column names, and it failed on `kind` — a closed
     * enum I had simply forgotten to list. The fix is not to extend the list and move on:
     * a hand-maintained allowlist needs a human to remember to think about the next column,
     * which is the same "somebody will notice" that this file exists to replace.
     *
     * So the schema half now allows only identifiers and columns declared to hold a closed
     * vocabulary, and the **data half proves the declaration** — every distinct value in each
     * of those columns must appear in the vocabulary the code actually emits. A column that
     * quietly started holding prose fails the second check even though it passed the first,
     * and a genuinely new text column fails the first.
     */
    const IDENTIFIER_COLUMNS = [
      "id",
      "org_id",
      "skill_id",
      "skill_version_id",
      "extractor_version",
    ];
    /** Column → the vocabulary it is *claimed* to hold. The claim is then tested. */
    const CLOSED_VOCABULARY_COLUMNS: Record<string, readonly string[]> = {
      type: BLOCK_TYPES as readonly string[],
      rule: BLOCK_RULES,
      kind: BLOCK_KINDS as readonly string[],
      parent_role: SECTION_ROLES as readonly string[],
    };

    const { rows: cols } = await c.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_name = 'skill_blocks' and table_schema = 'public'`,
    );
    const textish = cols.filter(
      (col) =>
        ["text", "character varying", "character"].includes(col.data_type) &&
        !IDENTIFIER_COLUMNS.includes(col.column_name) &&
        !(col.column_name in CLOSED_VOCABULARY_COLUMNS),
    );
    check(
      "skill_blocks has no free-text column that could hold content",
      textish.length === 0,
      textish.length > 0
        ? `${textish.map((t) => t.column_name).join(", ")} — if this is a closed vocabulary, add it to CLOSED_VOCABULARY_COLUMNS so its values are checked too`
        : `${Object.keys(CLOSED_VOCABULARY_COLUMNS).length} enum columns, ${IDENTIFIER_COLUMNS.length} identifiers`,
    );

    /**
     * How many rows there are decides which of the checks below mean anything.
     *
     * A schema assertion — "no free-text column", "a policy exists" — is true or false with
     * an empty table. A data assertion is not: `count(*) where value not in vocabulary`
     * returns zero on an empty table and reports **ok**, which is the same green-means-no-data
     * trap as the coverage check below and the one `verify:dedup` fell into while ingestion
     * was completely down. So the data half is gated and says which it is.
     */
    const { rows: populated } = await c.query<{ n: string }>(
      `select count(*)::text as n from skill_blocks where extractor_version = $1`,
      [EXTRACTOR_VERSION],
    );
    const hasRows = Number(populated[0].n) > 0;

    for (const [column, vocabulary] of Object.entries(CLOSED_VOCABULARY_COLUMNS)) {
      if (!hasRows) {
        console.info(
          `  skip  ${column} vocabulary — no rows at extractor ${EXTRACTOR_VERSION} to check`,
        );
        continue;
      }
      const { rows: bad } = await c.query<{ n: string; sample: string | null }>(
        `select count(*)::text as n, min(${column}) as sample
         from skill_blocks
         where extractor_version = $1 and ${column} is not null and ${column} <> all($2::text[])`,
        [EXTRACTOR_VERSION, vocabulary],
      );
      check(
        `${column} holds only its declared vocabulary (${vocabulary.length} values)`,
        bad[0].n === "0",
        bad[0].n === "0" ? "" : `${bad[0].n} rows outside it, e.g. ${bad[0].sample}`,
      );
    }

    const { rows: rls } = await c.query<{ n: string }>(
      `select count(*)::text as n from pg_policies where tablename = 'skill_blocks'`,
    );
    check("skill_blocks carries an RLS policy", Number(rls[0].n) > 0, `${rls[0].n} policy/policies`);

    if (!hasRows) {
      console.info(
        `  skip  block_types agreement and span sanity — nothing extracted at ${EXTRACTOR_VERSION} yet`,
      );
    } else {
    const { rows: agree } = await c.query<{ n: string }>(`
      select count(*)::text as n
      from skill_structures st
      where st.extractor_version = $1
        and exists (select 1 from skill_blocks b where b.skill_version_id = st.skill_version_id
                     and b.extractor_version = st.extractor_version)
        and (
          select coalesce(array_agg(distinct b.type order by b.type), '{}')
          from skill_blocks b
          where b.skill_version_id = st.skill_version_id
            and b.extractor_version = st.extractor_version and b.type is not null
        ) is distinct from coalesce(st.block_types, '{}')
    `, [EXTRACTOR_VERSION]);
    check(
      "the denormalised block_types agrees with skill_blocks on every row",
      agree[0].n === "0",
      `${agree[0].n} disagreeing`,
    );

    const { rows: spans } = await c.query<{ n: string }>(`
      select count(*)::text as n
      from skill_blocks b
      where b.extractor_version = $1
        and (b.start_char < 0 or b.end_char <= b.start_char)
    `, [EXTRACTOR_VERSION]);
    check("no stored span is empty or inverted", spans[0].n === "0", `${spans[0].n} bad spans`);
    }

    const { rows: coverage } = await c.query<{
      versions: string;
      blocks: string;
      classified: string;
    }>(`
      select
        count(distinct skill_version_id)::text as versions,
        count(*)::text as blocks,
        count(*) filter (where type is not null)::text as classified
      from skill_blocks where extractor_version = $1
    `, [EXTRACTOR_VERSION]);
    const cov = coverage[0];
    /**
     * Reported as a skip, not a pass, when there is nothing extracted yet.
     *
     * The first version was `blocks === 0 || (share > 20 && share < 100)`, which returned
     * **ok** against an empty table — a green light that meant only "no data". That is the
     * shape this codebase keeps paying for: `verify:dedup` was green throughout a total
     * ingestion outage. A check that cannot observe the failure it is about is not evidence,
     * so it now says which of the two it is.
     */
    if (Number(cov.blocks) === 0) {
      console.info(
        "  skip  no blocks stored at this extractor version yet — run pnpm structures --extract",
      );
    } else {
      const share = Math.round((Number(cov.classified) / Number(cov.blocks)) * 100);
      console.info(
        `  note  ${cov.versions} versions · ${cov.blocks} blocks · ${share}% classified`,
      );
      check(
        "the unclassified share is neither zero nor everything",
        share > 20 && share < 100,
        `${share}% classified — zero unclassified would mean the detector is guessing`,
      );
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
