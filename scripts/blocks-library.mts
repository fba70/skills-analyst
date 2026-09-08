import "dotenv/config";

import { BLOCK_TYPES, blockTypeLabel, isBlockType, type BlockType } from "../src/lib/block-types";
import { archetypeDetail } from "../src/server/analytics/archetype-read";
import { libraryFragments } from "../src/server/analytics/block-library";

/**
 * Read the block library from a terminal (Doc 6 RW.3).
 *
 *   pnpm blocks --library review                 # every published block type for a category
 *   pnpm blocks --library review --type guardrail
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

const category = value("library");
if (!category) {
  console.info("usage: pnpm blocks --library <category> [--type <block-type>] [--wider]");
  process.exit(1);
}

const requested = value("type");
if (requested !== undefined && !isBlockType(requested)) {
  console.info(`unknown block type: ${requested}\n  one of: ${BLOCK_TYPES.join(", ")}`);
  process.exit(1);
}
/* Narrowed by the guard above; `process.exit` does not narrow for the compiler. */
const only: BlockType | null = requested !== undefined && isBlockType(requested) ? requested : null;

const archetype = await archetypeDetail(category);
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
  `\n${archetype.label}  —  archetype v${archetype.version}, ${published.length} block types published`,
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
    limit: 4,
    includeWiderCorpus: args.includes("--wider"),
  });

  console.info(`\n  ${blockTypeLabel(type).toUpperCase()}`);
  if (result.fragments.length === 0) {
    console.info(
      `    none — ${result.bandEmpty ? "the curated band has no fragment of this type in bounds" : "no candidates"}` +
        `${args.includes("--wider") ? "" : " (try --wider)"}`,
    );
    continue;
  }

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

console.info("");
process.exit(0);
