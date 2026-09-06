import "server-only";

import { createHash } from "node:crypto";

import { embedMany } from "ai";

import { assertWithinBudget, recordUsage } from "@/server/billing/spend";

/**
 * Corpus embeddings (Doc 3 §Data model — pgvector, unparked).
 *
 * ## What is embedded: the claim, not the document
 *
 * Name, summary and category labels. **No body**, and that is a decision rather than a
 * shortcut.
 *
 * Every consumer waiting on these vectors matches on *what a skill claims to do*. R3.6 tells
 * an author "twelve similar skills exist, here is how yours differs" — a claim comparison.
 * RW.8 tests trigger collision, and what triggers a skill **is** its description; embedding
 * the body would actively blur the thing that lab measures. RK.5 clusters search queries
 * against what the corpus offers, which is again the claim. The description field is what an
 * agent reads to decide, so it is what similarity should be computed over.
 *
 * The practical half matters too. The body lives in object storage, not Postgres, so
 * including it would mean re-reading ~48,000 bundles from an EU bucket — measured at roughly
 * 2.5 hours for the block extraction that just did exactly that — for a marginal gain on the
 * axis none of the consumers care about. Summary-only turns the backfill into minutes.
 *
 * The known limitation, stated rather than discovered: two skills with equally bland
 * summaries will not separate. If body-level similarity is ever wanted — E2's contradiction
 * detection between guardrails is the likely first caller — the right answer is a second
 * embedder over **blocks**, which is a different unit with a different composition, not a
 * wider window on this one.
 *
 * ## The composition is pinned, because it is what drifts invisibly
 *
 * `EMBEDDER_VERSION` carries the model, the width *and* the composition. A model or width
 * change fails loudly at the insert, since the column is fixed-width. Only a composition
 * change can silently produce vectors that sit beside older ones, look current, and cannot
 * be compared to them — the same failure `classifier_version` exists to prevent, and the
 * reason the taxonomy bumped a version for a prompt change that touched no vocabulary entry.
 *
 * ## Cost, measured rather than estimated
 *
 * `openai/text-embedding-3-small` at $0.02 per million input tokens — read from the gateway
 * catalogue on 2026-09-06, not from memory. At ~60 tokens per skill over ~48,000 canonical
 * skills that is **about $0.06 for the whole corpus**, metered through the same `llm_usage`
 * ledger and platform budget as every other model call (RC.2, RC.3). An unmetered spend path
 * would make the platform cap a fiction.
 */

/** The gateway model id. Cheapest embedding model in the catalogue at this quality. */
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Native width of that model, and the ceiling Doc 3 sized the column for. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Model, width and composition in one string — the re-embed selector.
 *
 * Bump it for a model change, a dimension change, **or** a change to `composeInput`. The
 * third is the one that matters: the first two fail loudly at the insert because the column
 * is fixed-width, and only a composition change can silently produce vectors that coexist
 * with older ones and cannot be compared to them.
 */
export const EMBEDDER_VERSION = "1.0.0:text-embedding-3-small:1536:name+summary+labels";

export type EmbedInput = {
  name: string;
  summary: string | null;
  /** Function and domain labels, already resolved to human words. */
  labels: readonly string[];
};

/**
 * The exact string that gets embedded.
 *
 * Field-labelled rather than concatenated. The labels cost a handful of tokens and stop the
 * model having to guess whether a bare line is a title or a sentence of prose — and they
 * make a stored `input_hash` diffable by a human trying to work out why two vectors differ.
 */
export function composeInput(input: EmbedInput): string {
  const parts = [`name: ${input.name.trim()}`];
  if (input.summary?.trim()) parts.push(`summary: ${input.summary.replace(/\s+/g, " ").trim()}`);
  if (input.labels.length > 0) parts.push(`categories: ${input.labels.join(", ")}`);
  return parts.join("\n");
}

/** sha256 of the composed input, so an unchanged version is never paid for twice. */
export function inputHash(composed: string): string {
  return createHash("sha256").update(composed, "utf8").digest("hex");
}

export type EmbedBatchResult = {
  vectors: number[][];
  model: string;
  /** Total input tokens the provider charged for, across the batch. */
  inputTokens: number;
};

/**
 * Embed a batch, metered and budget-checked.
 *
 * The budget is asserted **before** the call and the ledger written **after**, which is the
 * order RC.2 fixed and the reason one call can carry the total slightly past the cap: cost
 * is only knowable once tokens are counted. Reserving an estimate up front would refuse
 * legitimate work whenever the estimate ran high, to avoid an overshoot bounded by a single
 * batch.
 *
 * Fails closed. `assertWithinBudget` throws before any request, so a backfill that reaches
 * the platform cap stops rather than degrading to a cheaper model or a smaller window —
 * either of which would leave the table holding vectors that are not comparable with each
 * other, which is worse than holding fewer.
 */
export async function embedBatch(inputs: readonly string[]): Promise<EmbedBatchResult> {
  if (inputs.length === 0) return { vectors: [], model: EMBEDDING_MODEL, inputTokens: 0 };

  await assertWithinBudget("corpus_embedding", null);

  const { embeddings, usage } = await embedMany({
    model: EMBEDDING_MODEL,
    values: [...inputs],
  });

  /**
   * `usage.tokens` for `embedMany`, not `inputTokens`.
   *
   * The embedding usage shape differs from the text one — there are no output tokens to
   * report, so the SDK reports a single total. Reading `inputTokens` here returns undefined
   * and would meter the entire backfill as **zero cost**, which is the exact shape of the
   * `recordUsage` bug that made builder spend invisible: a meter that silently records
   * nothing leaves the cap unreachable and RC.2 satisfied on paper only.
   */
  const inputTokens = usage?.tokens ?? 0;

  await recordUsage({
    purpose: "corpus_embedding",
    orgId: null,
    model: EMBEDDING_MODEL,
    usage: { inputTokens, outputTokens: 0 },
    subjectType: "corpus",
  });

  const wrong = embeddings.find((vector) => vector.length !== EMBEDDING_DIMENSIONS);
  if (wrong) {
    /**
     * Checked here as well as by the column, because the column's failure arrives one layer
     * later and names a type rather than a cause. Mixed-width vectors in one column are
     * silently meaningless — the index still answers queries — so this is worth two checks.
     */
    throw new Error(
      `${EMBEDDING_MODEL} returned ${wrong.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
        `Bump EMBEDDER_VERSION and the column width together, or the table ends up holding ` +
        `two incomparable populations.`,
    );
  }

  return { vectors: embeddings, model: EMBEDDING_MODEL, inputTokens };
}
