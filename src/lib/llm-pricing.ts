/**
 * What a model call costs, in one place (Doc 2 RC.2, RC.3).
 *
 * A leaf module with no imports, because three very different callers need the same
 * arithmetic: the meter that records a call, the cap that refuses one, and the settings
 * panel that explains the bill. Three copies of a price table is three chances to enforce a
 * budget against numbers nobody has checked.
 *
 * ## Prices are a fact about the world, not about this codebase
 *
 * They change without asking us, and a stale table makes every cap quietly wrong in the
 * same direction. So each entry records when it was verified and against what, and
 * `UNKNOWN_MODEL_RATE` deliberately over-charges rather than under-charging an unlisted
 * model — a budget that silently ignores a model it does not recognise is not a budget.
 *
 * Verified 2026-06-24 against Anthropic's published first-party API rates. The AI Gateway
 * bills at those rates for these models.
 */

export type ModelRate = {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
};

export const MODEL_RATES: Record<string, ModelRate> = {
  "anthropic/claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  "anthropic/claude-haiku-4.5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "anthropic/claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
};

/**
 * What an unrecognised model is charged at.
 *
 * The most expensive rate we know of, on purpose. If someone points a call at a model this
 * table has never heard of, the honest failure is to over-estimate its cost and hit the cap
 * early — under-estimating means the budget stops being one exactly when a new, pricier
 * model is introduced, which is the moment it matters most.
 */
export const UNKNOWN_MODEL_RATE: ModelRate = { inputPerMTok: 5.0, outputPerMTok: 25.0 };

/**
 * Cache multipliers, applied to the *input* rate.
 *
 * Writing to the cache costs more than an ordinary input token and reading from it costs
 * far less. Ignoring both — charging every input token at the base rate — would overstate a
 * cached workload's cost by roughly ten times on the read side, which for the taxonomy
 * classifier is most of its traffic.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export type TokenCounts = {
  /** Input tokens billed at the full rate (cache misses). */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export function rateFor(model: string): ModelRate {
  return MODEL_RATES[model] ?? UNKNOWN_MODEL_RATE;
}

/**
 * Cost of one call, in **micro-dollars** (millionths of a dollar).
 *
 * Integer arithmetic, deliberately. A per-call cost is often a fraction of a cent, and
 * accumulating floats across thousands of calls drifts — a budget that disagrees with the
 * sum of its own ledger is worse than no budget. Micro-dollars keep every value an integer
 * a database column can hold exactly, and $1 is 1,000,000 of them.
 */
export function costMicros(model: string, tokens: TokenCounts): number {
  const rate = rateFor(model);

  const inputMicros =
    (tokens.inputTokens * rate.inputPerMTok +
      tokens.cacheWriteTokens * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      tokens.cacheReadTokens * rate.inputPerMTok * CACHE_READ_MULTIPLIER) /
    1_000_000;

  const outputMicros = (tokens.outputTokens * rate.outputPerMTok) / 1_000_000;

  // Rounded up: a call that costs a fraction of a micro-dollar still costs something, and
  // rounding thousands of them to zero would let a cap be evaded by making tiny calls.
  return Math.ceil((inputMicros + outputMicros) * 1_000_000);
}

/** `1234567` → `$1.23`. For display only; never round-trip a formatted value. */
export function formatMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}
