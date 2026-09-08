import "server-only";

import { blockTypeBlurb, blockTypeLabel, type BlockType } from "@/lib/block-types";
import { archetypeDetail } from "@/server/analytics/archetype-read";
import { extractStructure } from "@/server/analytics/structure";

/**
 * Where a draft departs from its archetype, at block granularity (Doc 2 R4.3, Doc 6 RW.3).
 *
 * R4.3 asks that archetype deviations be visibly marked, and until now nothing marked them.
 * The builder offered a section skeleton and never looked at what came back — so an author
 * could accept a scaffold, generate, and publish a document missing the one block type the
 * corpus most strongly rewards in their category, with every panel on the page green.
 *
 * ## Measured with the corpus's own instrument, deliberately
 *
 * The draft is run through **`extractStructure`** — the same extractor that produced all
 * 1.6 million corpus blocks — by handing it a one-file bundle. Nothing here reimplements
 * segmentation.
 *
 * That is the whole reason this comparison means anything. A second, lighter detector would
 * drift from the first, and every drift would show up as a deviation the author cannot act
 * on: the archetype would say 75% of curated skills carry a decision rule, the draft would
 * genuinely carry one, and a different parser would report it missing. Same argument R6.1
 * makes for publish-back calling the real validator, and RM.2 makes for the MCP tools
 * calling the same reads as the web pages.
 *
 * ## A deviation is information, never an error
 *
 * Doc 2's risk register names archetype homogenisation explicitly, and the archetype pages
 * are written to keep deviation allowed and tracked rather than corrected. So:
 *
 * - a **missing** block type states the evidence and stops. There is no "fix this" and
 *   nothing is blocked; a skill with no decisions to make should not carry a decision rule,
 *   and an author is the only one who knows which case they are in.
 * - an **extra** block type carries no judgement at all. It is listed because an author
 *   might want to know what they wrote, and that is the entire claim. Two block types
 *   measure *negative* lift corpus-wide and neither is published as guidance — the reasoning
 *   is in `archetype.ts` — so calling an unmeasured type a deviation here would smuggle in
 *   through the builder the negative claim the miner deliberately refuses to make.
 * - **density is reported and never scored.** Inclusion in the archetype is decided on
 *   presence; the per-skill counts are descriptive evidence that was never significance
 *   tested, and a builder that demanded 4.3 procedures would be enforcing an untested mean.
 */

export type BlockDeviation = {
  type: BlockType;
  label: string;
  blurb: string;
  /** How many the draft actually contains. */
  drafted: number;
  /** Prevalence in the band the archetype was mined from. */
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
  /** Mean per skill in the strong band. Descriptive — see the note above. */
  strongDensity: number;
  required: boolean;
};

export type DeviationReport = {
  category: string;
  categoryLabel: string;
  archetypeVersion: number;
  /** Recommended by the archetype and present in the draft. */
  followed: BlockDeviation[];
  /** Recommended by the archetype and absent from the draft. */
  missing: BlockDeviation[];
  /** In the draft and not part of this category's grammar. Descriptive only. */
  extra: Array<{ type: BlockType; label: string; drafted: number }>;
  /** Blocks the extractor could not type. Content, not a defect. */
  unclassified: number;
  totalBlocks: number;
  /**
   * True when the archetype predates miner 3.0.0 or measured no blocks.
   *
   * Distinguished from "nothing is missing", because an empty `missing` list means opposite
   * things in the two cases and a panel that cannot tell them apart would report a draft as
   * fully conformant when nothing had been compared.
   */
  notMeasured: boolean;
};

/**
 * Compare one draft body against its category's block grammar.
 *
 * Returns null only for an unknown category or one with no archetype at all — the caller
 * renders nothing rather than an empty panel, because "no archetype exists here" is already
 * said by the scaffold that produced the draft.
 */
export async function blockDeviations(
  body: string,
  category: string,
): Promise<DeviationReport | null> {
  const archetype = await archetypeDetail(category);
  if (!archetype) return null;

  /*
   * A synthetic one-file bundle, because that is what a draft is.
   *
   * `bundlePaths` therefore holds only the marker itself, which makes a
   * `reference-pointer` to `references/foo.md` resolve as a link to something absent. That
   * is correct rather than a limitation: a text-only draft genuinely has no bundled files
   * yet, and the R2.3 analyzer is excluded from draft validation for exactly this reason.
   */
  const fingerprint = extractStructure({
    body,
    frontmatter: {},
    files: [{ path: "SKILL.md", content: Buffer.from(body, "utf8") }],
    markerPath: "SKILL.md",
  });

  const drafted = new Map<string, number>();
  let unclassified = 0;
  for (const block of fingerprint.blocks) {
    if (block.type === null) unclassified += 1;
    else drafted.set(block.type, (drafted.get(block.type) ?? 0) + 1);
  }

  const grammar = archetype.skeleton.blocks ?? [];
  const followed: BlockDeviation[] = [];
  const missing: BlockDeviation[] = [];

  for (const block of grammar) {
    const count = drafted.get(block.type) ?? 0;
    const entry: BlockDeviation = {
      type: block.type,
      label: blockTypeLabel(block.type),
      blurb: blockTypeBlurb(block.type),
      drafted: count,
      strongPrevalence: block.strongPrevalence,
      weakPrevalence: block.weakPrevalence,
      lift: block.lift,
      strongDensity: block.strongDensity,
      required: block.required,
    };
    if (count > 0) followed.push(entry);
    else missing.push(entry);
  }

  const inGrammar = new Set(grammar.map((b) => b.type as string));
  const extra = [...drafted.entries()]
    .filter(([type]) => !inGrammar.has(type))
    .map(([type, count]) => ({
      type: type as BlockType,
      label: blockTypeLabel(type),
      drafted: count,
    }))
    .sort((a, b) => b.drafted - a.drafted);

  return {
    category,
    categoryLabel: archetype.label,
    archetypeVersion: archetype.version,
    /* Missing sorts by lift: the type the corpus rewards most is the one worth reading first. */
    followed: followed.sort((a, b) => b.lift - a.lift),
    missing: missing.sort((a, b) => b.lift - a.lift),
    extra,
    unclassified,
    totalBlocks: fingerprint.blocks.length,
    notMeasured: grammar.length === 0,
  };
}
