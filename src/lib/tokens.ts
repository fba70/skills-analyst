/**
 * Activation cost: what a skill costs the agent that loads it (Doc 6 RW.9).
 *
 * A leaf module with no imports, for the same reason as `quality.ts`: four callers need the
 * same numbers and an explanation that drifts from the computation is worse than none. The
 * extractor computes the estimate, the skill page shows it, the structural lint enforces the
 * budget it is banded against, and `/faq` explains all three.
 *
 * ## Why this is a measurement worth having at all
 *
 * Every other number in the registry describes the document. This one describes what the
 * document *does to you*: a skill is paid for in context tokens on every activation, and
 * nothing in the ecosystem tells an author what theirs costs. RW.9's eventual pitch — "this
 * skill costs 4.2K tokens per activation; here's a 1.9K version with identical eval results"
 * — needs the first half to exist before the second can be built. This is the first half.
 *
 * ## It is an estimate, and it says so everywhere it appears
 *
 * Four characters to the token for prose, three for code, because identifiers and
 * punctuation split more often. That lands within roughly ten percent for English text and
 * it is **not** a tokenizer: Claude's is not public, a BPE dependency would be an install
 * this project has not taken, and an exact count per skill would mean an API call per skill.
 *
 * The honest consequence is that this number is good for *comparing* — this draft against
 * that draft, a compressed variant against its original, which is exactly what D4 needs —
 * and should never be quoted as a fact about someone's context window. Every surface labels
 * it. If a real count is ever wanted, it replaces `estimateTokens` and nothing else, and the
 * extractor version bump is the whole migration.
 *
 * ## The bands are derived from the size budget, not invented
 *
 * `MAX_BODY_BYTES` and `DISCLOSURE_HINT_BYTES` moved here from `structural-lint.ts` with
 * their values unchanged — same reason `SEVERITY_WEIGHTS` moved into `quality.ts`. The lint
 * already had an opinion about a document being too big, so a cost display with its *own*
 * thresholds would eventually tell an author their skill is fine while the validator flagged
 * it as an oversized monolith. Now the boundaries are the same policy expressed in two
 * units, and there is one copy of it.
 */

/**
 * Body size above which progressive disclosure is suggested (R2.7).
 *
 * Below the hard cap, so it warns rather than blocks: a long document with a `references/`
 * directory has already made the disclosure decision, and one without it probably has not.
 */
export const DISCLOSURE_HINT_BYTES = 15_000;

/** Body size above which the marker is flagged as an oversized monolith (R2.7). */
export const MAX_BODY_BYTES = 40_000;

/**
 * Characters per token, by content kind.
 *
 * Prose runs about four; code about three, because identifiers, brackets and operators split
 * more often than words do. Exported so `/faq` can state the basis rather than paraphrase it.
 */
export const CHARS_PER_TOKEN = { prose: 4, code: 3 } as const;

export type ContentKind = keyof typeof CHARS_PER_TOKEN;

/**
 * Estimated tokens for a passage. Never returns zero for non-empty text.
 *
 * The floor of 1 matters: a block library ranks fragments partly on cost, and a
 * one-character block reporting zero would sort as free.
 */
export function estimateTokens(text: string, kind: ContentKind = "prose"): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN[kind]));
}

export type CostBand = "lean" | "typical" | "heavy" | "oversized";

/**
 * Band boundaries, in tokens, computed from the byte budgets above.
 *
 * Derived rather than written down, so moving a byte budget moves the bands with it and the
 * two cannot disagree. `typical` starts where `quality.ts` stops calling a document thin
 * (`SUBSTANTIAL_BYTES`, 2,000 bytes — restated here as a number rather than imported,
 * because a leaf module importing another leaf module for one constant is the beginning of
 * the cycle both exist to avoid; `verify:tokens` asserts the two still agree).
 */
export const COST_BANDS = {
  typical: estimateTokens("x".repeat(2_000)),
  heavy: estimateTokens("x".repeat(DISCLOSURE_HINT_BYTES)),
  oversized: estimateTokens("x".repeat(MAX_BODY_BYTES)),
} as const;

export function costBand(tokens: number): CostBand {
  if (tokens >= COST_BANDS.oversized) return "oversized";
  if (tokens >= COST_BANDS.heavy) return "heavy";
  if (tokens >= COST_BANDS.typical) return "typical";
  return "lean";
}

export const COST_BAND_META: Record<CostBand, { label: string; blurb: string }> = {
  lean: {
    label: "Lean",
    blurb: "Cheap to load. Short enough that carrying it costs an agent almost nothing.",
  },
  typical: {
    label: "Typical",
    blurb: "The ordinary range: enough content to be useful without crowding the context.",
  },
  heavy: {
    label: "Heavy",
    blurb:
      "Large enough that moving detail into references/ would pay for itself on every activation.",
  },
  oversized: {
    label: "Oversized",
    blurb: "Past the size budget the validator flags. Every activation pays for all of it.",
  },
};

/** `1819` → `"1.8K"`. Compact, because the precision is not there to spend. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(1)}K`;
}
