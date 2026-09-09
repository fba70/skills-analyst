import "dotenv/config";

import { Client } from "pg";

import { REDISTRIBUTABLE } from "../src/lib/licence";
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

/*
 * ---------------------------------------------------------------------------------------
 * The block library (Doc 6 RW.3) — a coordinate resolved back into the right passage
 * ---------------------------------------------------------------------------------------
 *
 * Everything above checks that spans were stored correctly. The library *reads* them, and
 * that is where the interesting failure lives: `skill_blocks` holds character offsets into
 * the marker body, so a reader using a different offset base returns a passage shifted by
 * the length of the YAML block — **plausible text, wrongly attributed to a named
 * repository**. Nothing about that looks broken from the outside.
 *
 * The first draft of `block-library.ts` had exactly that bug in waiting: a three-line local
 * frontmatter stripper instead of `splitFrontmatter`. So the check below does not compare
 * the library against a hand-written expectation — it compares it against **the extractor's
 * own slice of the same bundle**, which is the only authority on where a body starts.
 */
console.info("\nThe library resolves a coordinate back to the extractor's own text");

{
  const c2 = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  let connected = false;
  try {
    await c2.connect();
    connected = true;
  } catch {
    console.info("  skip  no database connection");
  }

  if (connected) {
    const { rows: exists } = await c2.query<{ present: boolean }>(
      `select to_regclass('public.skill_blocks') is not null as present`,
    );
    let stored = "0";
    if (exists[0].present) {
      const { rows } = await c2.query<{ n: string }>(
        `select count(*)::text as n from skill_blocks where extractor_version = $1`,
        [EXTRACTOR_VERSION],
      );
      stored = rows[0].n;
    }

    if (stored === "0") {
      console.info("  skip  no blocks stored yet — run pnpm structures --extract --drain");
    } else {
      const { libraryFragments, FRAGMENT_MIN_WORDS, FRAGMENT_MAX_WORDS } = await import(
        "../src/server/analytics/block-library"
      );
      const { archetypeDetail } = await import("../src/server/analytics/archetype-read");

      /*
       * `review` is the largest banded category and the one the block finding was measured
       * on, so it is the one with something to lose if this breaks.
       */
      const archetype = await archetypeDetail("review");
      const published = (archetype?.skeleton.blocks ?? []).map((b) => b.type);

      if (published.length === 0) {
        console.info("  skip  the review archetype publishes no blocks — re-mine at 3.0.0");
      } else {
        const result = await libraryFragments({ category: "review", type: published[0], limit: 4 });
        check(
          "the library returns fragments for a published block type",
          result.fragments.length > 0,
          `${result.fragments.length} for ${published[0]}`,
        );

        check(
          "every fragment is within the exemplar bounds",
          result.fragments.every(
            (f) => f.wordCount >= FRAGMENT_MIN_WORDS && f.wordCount <= FRAGMENT_MAX_WORDS,
          ),
          `${FRAGMENT_MIN_WORDS}-${FRAGMENT_MAX_WORDS} words`,
        );

        /**
         * One per source, which is the fragment-scale version of counting distinct
         * structures rather than skills.
         *
         * The first ranking returned three of four reference pointers from one repository,
         * all three unquotable. A panel of four items with one usable is what this prevents.
         */
        const sources = result.fragments.map((f) => f.attribution.source);
        check(
          "no source contributes two fragments to one list",
          new Set(sources).size === sources.length,
          sources.join(", ").slice(0, 90),
        );

        /**
         * The licence gate, asserted as a property of the result rather than of the data.
         *
         * `metadata_only` and `unresolved` skills are analysed and never copied. Their rows
         * exist — that is the point of storing a coordinate — so the failure this rules out
         * is text arriving beside a posture that forbids it.
         */
        const leaked = result.fragments.filter(
          (f) =>
            f.text !== null &&
            !(REDISTRIBUTABLE as readonly string[]).includes(f.attribution.redistribution),
        );
        check(
          "no fragment carries text its licence does not permit copying",
          leaked.length === 0,
          leaked.map((f) => `${f.attribution.slug}:${f.attribution.redistribution}`).join(", ") ||
            "the download route's own two postures, and no others",
        );

        check(
          "a withheld fragment still carries attribution and a reason",
          result.fragments
            .filter((f) => f.text === null)
            .every((f) => f.withheld !== null && f.attribution.source.length > 0),
          "attribution plus a link to origin is a real answer; a blank row is not",
        );

        /**
         * The offset-base check, and the reason this section exists.
         *
         * Re-extract the same bundle with the real extractor, find the block at the same
         * span, and require the library's text to be that block's own slice. If the two ever
         * disagree about where the body starts, this goes red — where a hand-written
         * expectation would have gone green on plausible, wrong text.
         */
        const quotable = result.fragments.find((f) => f.text !== null);
        if (!quotable) {
          console.info("  skip  no quotable fragment in this sample to re-derive");
        } else {
          const { rows: loc } = await c2.query<{
            content_hash: string;
            content_stored: boolean;
            marker_path: string;
            start_char: number;
            end_char: number;
            provenance: unknown;
          }>(
            `select sv.content_hash, sv.content_stored, st.marker_path,
                    b.start_char, b.end_char, sv.provenance
             from skill_blocks b
             join skill_versions sv on sv.id = b.skill_version_id
             join skill_structures st on st.skill_version_id = sv.id
               and st.extractor_version = b.extractor_version
             where b.id = $1`,
            [quotable.id],
          );

          const { loadBundle } = await import("../src/server/validation/bundle-loader");
          const { splitFrontmatter } = await import("../src/server/skills/normalize");

          const bundle = await loadBundle({
            contentStored: loc[0].content_stored,
            contentHash: loc[0].content_hash,
            tier: "public",
            provenance: loc[0].provenance as never,
          });
          const marker = bundle.files.find((f) => f.path === loc[0].marker_path);
          check(
            "the marker file the offsets belong to is the one the fingerprint named",
            Boolean(marker),
            loc[0].marker_path,
          );

          if (marker) {
            const { frontmatter, body } = splitFrontmatter(marker.content.toString("utf8"));
            const fingerprint = extractStructure({
              body,
              frontmatter,
              files: bundle.files,
              markerPath: loc[0].marker_path,
            });
            const same = fingerprint.blocks.find(
              (b) => b.startChar === loc[0].start_char && b.endChar === loc[0].end_char,
            );
            check(
              "the stored span still matches a block the extractor produces today",
              Boolean(same),
              `${loc[0].start_char}-${loc[0].end_char} in ${quotable.attribution.slug}`,
            );

            const expected = body.slice(loc[0].start_char, loc[0].end_char).trim();
            check(
              "the library's text is the extractor's own slice, character for character",
              quotable.text === expected,
              quotable.text === expected
                ? `${expected.length} chars agree`
                : `library ${quotable.text?.length} vs extractor ${expected.length} chars`,
            );

            /*
             * And the bug reproduced, so the check above is proven to be able to fail.
             *
             * Slicing the *whole file* is what a local frontmatter stripper gets wrong. On a
             * skill with frontmatter the two must differ; on one without, they are legitimately
             * identical and the case is skipped rather than asserted, because a fixture that
             * cannot reproduce the bug proves nothing.
             */
            const raw = marker.content.toString("utf8");
            if (raw === body) {
              console.info(
                "  skip  this fragment's skill has no frontmatter, so the wrong base cannot differ",
              );
            } else {
              const wrongBase = raw.slice(loc[0].start_char, loc[0].end_char).trim();
              check(
                "reading the same offsets against the un-split file gives different text",
                wrongBase !== expected,
                "proves the offset base is load-bearing rather than incidental",
              );
            }
          }
        }
      }

      /*
       * The other half of RW.3: a draft is compared with the same instrument.
       *
       * `blockDeviations` runs `extractStructure` over a synthetic one-file bundle, so a
       * corpus skill's own body must come back reporting the blocks the corpus already
       * stored for it. Anything else means the draft comparison and the archetype it is
       * compared against are measuring with two different rulers.
       */
      const { blockDeviations } = await import("../src/server/builder/deviation");
      const { rows: sample } = await c2.query<{
        slug: string;
        content_hash: string;
        content_stored: boolean;
        marker_path: string;
        provenance: unknown;
        stored_types: string[];
      }>(
        `select sk.slug, sv.content_hash, sv.content_stored, st.marker_path, sv.provenance,
                (select array_agg(distinct b.type) from skill_blocks b
                  where b.skill_version_id = sv.id and b.extractor_version = $1
                    and b.type is not null) as stored_types
         from skills sk
         join skill_versions sv on sv.id = sk.current_version_id
         join skill_structures st on st.skill_version_id = sv.id and st.extractor_version = $1
         join skill_categories c on c.skill_id = sk.id and c.axis = 'function' and c.value = 'review'
         where sk.status = 'indexed' and sv.content_stored and st.marker_path is not null
           and st.block_count > 6
         order by sk.quality_score desc nulls last, sk.id
         limit 1`,
        [EXTRACTOR_VERSION],
      );

      if (sample.length === 0) {
        console.info("  skip  no stored review skill to re-measure as a draft");
      } else {
        const { loadBundle } = await import("../src/server/validation/bundle-loader");
        const { splitFrontmatter } = await import("../src/server/skills/normalize");
        const bundle = await loadBundle({
          contentStored: sample[0].content_stored,
          contentHash: sample[0].content_hash,
          tier: "public",
          provenance: sample[0].provenance as never,
        });
        const marker = bundle.files.find((f) => f.path === sample[0].marker_path);
        const { body } = splitFrontmatter(marker?.content.toString("utf8") ?? "");
        const report = await blockDeviations(body, "review");

        check(
          "the draft comparison types blocks in a real document",
          report !== null && report.totalBlocks > 0,
          `${report?.totalBlocks ?? 0} blocks in ${sample[0].slug}`,
        );
        check(
          "it distinguishes 'no blocks measured' from 'nothing missing'",
          report !== null && report.notMeasured === false,
          "an archetype without blocks must not read as a fully conformant draft",
        );
        /*
         * The types it finds are the types already stored for the same document. Not a
         * tautology across a version bump: the stored rows came from a batch run weeks ago
         * and this runs the extractor now, so a change to segmentation that nobody
         * re-extracted for shows up here as a disagreement.
         */
        const found = new Set([
          ...(report?.followed ?? []).map((b) => b.type as string),
          ...(report?.extra ?? []).map((b) => b.type as string),
        ]);
        const storedTypes = new Set(sample[0].stored_types ?? []);
        const drift = [...storedTypes].filter((x) => !found.has(x));
        check(
          "re-measuring a stored document finds the block types already stored for it",
          drift.length === 0,
          drift.length > 0
            ? `missing ${drift.join(", ")} — the extractor moved without a re-extract`
            : `${storedTypes.size} types agree`,
        );
      }
    }
    await c2.end();
  }
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
