import "dotenv/config";

import { BLOCK_TYPES, blockTypeLabel, isBlockType, type BlockType } from "../src/lib/block-types";
import { isToolId, TOOL_IDS, toolById, toolLabel } from "../src/lib/tools";
import { archetypeDetail } from "../src/server/analytics/archetype-read";
import { libraryFragments } from "../src/server/analytics/block-library";

/**
 * Read the block library from a terminal (Doc 6 RW.3, Doc 7 RD.9).
 *
 *   pnpm blocks --library review                 # every published block type for a category
 *   pnpm blocks --library review --type guardrail
 *   pnpm blocks --library review --tool git      # only skills that name one tool (RD.9)
 *   pnpm blocks --tool pandoc                    # the same library across every category
 *
 * Free: one query plus a bounded set of object reads, no model.
 *
 * It exists because a library is the one feature in this programme whose output cannot be
 * judged from a row count. "Six guardrail fragments resolved" is a number; whether they are
 * passages worth showing an author is a thing somebody has to read. So the resolved text is
 * printed, truncated, with its attribution.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * One printer for both surfaces.
 *
 * A withheld fragment keeps its attribution and its origin link and loses only its text —
 * that is the licence gate, and it has to look the same however the fragment was found.
 */
function render(result: Awaited<ReturnType<typeof libraryFragments>>): void {
  for (const f of result.fragments) {
    const badge = f.attribution.curated ? "curated" : "wider corpus";
    console.info(
      `    ${f.attribution.slug}  ·  ${f.attribution.source}  ·  ${badge}` +
        `  ·  q${f.attribution.qualityScore ?? "—"}  ·  ${f.wordCount}w  ·  ~${f.tokenEstimate}tok`,
    );
    if (f.text) {
      const flat = f.text.replace(/\s+/g, " ");
      console.info(`      ${flat.slice(0, 220)}${flat.length > 220 ? " …" : ""}`);
    } else {
      console.info(
        `      [withheld: ${f.withheld}] ${f.attribution.redistribution} · ${f.attribution.sourceUrl ?? "no origin url"}`,
      );
    }
  }
  if (result.withheldForLicence > 0) {
    console.info(
      `    ${result.withheldForLicence} of ${result.candidates} withheld — licence does not permit copying`,
    );
  }
}

/*
 * `--library <category>` is the original surface, and a category is not always the right
 * frame: *what does a good guardrail about `git` look like* is not a question about `review`
 * skills, which is exactly why `libraryFragments` made `category` optional (RD.9). Until this
 * flag existed that corpus-wide path could only be reached by `/tools/<id>` — and a claim
 * about what it returns was made here from a command that does something else. A surface no
 * command can reach is a surface nobody checks.
 */
const category = value("library");
const corpusWide = args.includes("--tool") && (!category || category.startsWith("--"));
if (!category && !corpusWide) {
  console.info(
    "usage: pnpm blocks --library <category> [--type <block-type>] [--tool <tool-id>] [--wider]" +
      "\n       pnpm blocks --tool <tool-id>            # the same library across every category",
  );
  process.exit(1);
}

const requestedTool = value("tool");
if (requestedTool !== undefined && !isToolId(requestedTool)) {
  /*
   * The whole vocabulary, not a shrug. An unrecognised id silently returning nothing reads as
   * "no skill has a good guardrail about this", which is a claim about the corpus rather than
   * about the typo — the same reason the MCP search tool answers an invented category with its
   * enumeration instead of an empty list.
   */
  console.info(`unknown tool: ${requestedTool}\n  one of:`);
  let line = "   ";
  for (const id of TOOL_IDS) {
    if (line.length + id.length + 2 > 96) {
      console.info(line);
      line = "   ";
    }
    line += ` ${id}`;
  }
  console.info(line);
  process.exit(1);
}
const tool: string | undefined = requestedTool;

const requested = value("type");
if (requested !== undefined && !isBlockType(requested)) {
  console.info(`unknown block type: ${requested}\n  one of: ${BLOCK_TYPES.join(", ")}`);
  process.exit(1);
}
/* Narrowed by the guard above; `process.exit` does not narrow for the compiler. */
const only: BlockType | null = requested !== undefined && isBlockType(requested) ? requested : null;

if (corpusWide) {
  /*
   * The corpus-wide view, through **the same function `/tools/<id>` renders** rather than a
   * second walk over the types — so what the page shows and what this prints cannot diverge,
   * which is the whole argument for the page reading a shared reader at all.
   */
  const { toolEvidence } = await import("../src/server/skills/tools-read");
  const destructive = toolById(tool as string)?.destructive ?? false;
  const { groups, available } = await toolEvidence(tool as string, destructive);
  console.info(
    `\n${toolLabel(tool as string)}  —  every category, curated band` +
      (destructive ? "  ·  destructive, so guardrails lead" : ""),
  );
  if (!available) {
    console.info("  skill_tools is absent — pnpm structures --resolve-tools --drain\n");
    process.exit(0);
  }
  if (groups.length === 0) {
    console.info("  nothing quotable was found for this tool — which is not the same as unused\n");
    process.exit(0);
  }
  for (const group of groups) {
    console.info(`\n  ${group.type.toUpperCase().replace(/-/g, " ")}`);
    render(group.result);
  }
  console.info("");
  process.exit(0);
}

const archetype = await archetypeDetail(category as string);
if (!archetype) {
  console.info(`no archetype for ${category} — nothing has been mined for it`);
  process.exit(1);
}

/*
 * Driven by the archetype's own block list, not by all eleven types.
 *
 * The library exists to answer "what does a good one look like" about guidance the platform
 * already gave. Offering fragments for a type this category does not reward would be the
 * platform recommending something its own measurement rejected.
 */
const published = (archetype.skeleton.blocks ?? []).map((b) => b.type);
const types: BlockType[] = only ? [only] : published;

console.info(
  `\n${archetype.label}  —  archetype v${archetype.version}, ${published.length} block types published` +
    (tool ? `  ·  restricted to skills naming ${toolLabel(tool)}` : ""),
);
if (only && !published.includes(only)) {
  console.info(
    `  note  ${only} is NOT published for this category — showing fragments anyway because` +
      `\n        you asked for it by name, but the archetype does not recommend it here.`,
  );
}

for (const type of types) {
  const result = await libraryFragments({
    category,
    type,
    tool,
    limit: 4,
    includeWiderCorpus: args.includes("--wider"),
  });

  console.info(`\n  ${blockTypeLabel(type).toUpperCase()}`);
  if (result.refusal) {
    console.info(`    ${result.refusal}`);
    continue;
  }
  if (result.fragments.length === 0) {
    console.info(
      `    none — ${result.bandEmpty ? "the curated band has no fragment of this type in bounds" : "no candidates"}` +
        `${tool ? ` that also names ${toolLabel(tool)}` : ""}` +
        `${args.includes("--wider") ? "" : " (try --wider)"}`,
    );
    continue;
  }

  render(result);
}

console.info("");
process.exit(0);
