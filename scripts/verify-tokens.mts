import "dotenv/config";

import { Client } from "pg";

import { FAQ_SECTIONS } from "../src/lib/faq";
import { SUBSTANTIAL_BYTES } from "../src/lib/quality";
import {
  CHARS_PER_TOKEN,
  COST_BAND_META,
  COST_BANDS,
  costBand,
  DISCLOSURE_HINT_BYTES,
  estimateTokens,
  formatTokens,
  MAX_BODY_BYTES,
} from "../src/lib/tokens";
import { EXTRACTOR_VERSION } from "../src/server/analytics/structure";

/**
 * Activation cost is consistent, banded against the real budget, and honest (Doc 6 RW.9).
 *
 *   pnpm verify:tokens
 *
 * Free. No model, no network; the stored half reads one table and writes nothing.
 *
 * ## What is actually at risk here
 *
 * Not the arithmetic — a division is hard to get wrong. The risks are all about a number
 * that *looks* measured:
 *
 *   1. **The bands drifting from the budget they claim to come from.** The whole argument
 *      for deriving `COST_BANDS` from `MAX_BODY_BYTES` is that a cost display with its own
 *      thresholds would eventually call a document fine while the validator called it an
 *      oversized monolith. That only holds while the derivation holds, so it is asserted
 *      rather than trusted.
 *   2. **The estimator changing without an extractor bump.** Every stored `token_estimate`
 *      came from this function. Change the divisors and 51,000 stored rows silently mean
 *      something else, while `--status` still reports them as current.
 *   3. **A zero being rendered as a measurement.** During a re-extract most versions have
 *      no fingerprint, and "0 tokens" is a claim about the skill where absence is a claim
 *      about us.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe estimator");

check(
  "prose and code use different divisors, and code is denser",
  CHARS_PER_TOKEN.code < CHARS_PER_TOKEN.prose,
  `prose ${CHARS_PER_TOKEN.prose}, code ${CHARS_PER_TOKEN.code}`,
);

/**
 * The divisors are pinned here on purpose.
 *
 * Not a tautology: this is the only thing standing between "someone improves the estimator"
 * and 51,000 stored rows quietly meaning something different while `structures --status`
 * still calls them current. If this check goes red, the fix is an `EXTRACTOR_VERSION` bump
 * and a re-extract, and that is the message it should deliver.
 */
check(
  "the divisors are unchanged (change them and every stored token_estimate is stale)",
  CHARS_PER_TOKEN.prose === 4 && CHARS_PER_TOKEN.code === 3,
  `if this is deliberate, bump EXTRACTOR_VERSION (now ${EXTRACTOR_VERSION}) and re-extract`,
);

check("empty text costs nothing", estimateTokens("") === 0);
check(
  "a single character costs one token, never zero",
  estimateTokens("x") === 1,
  "a block library ranks on cost; a zero would sort as free",
);
check(
  "cost rises with length",
  estimateTokens("x".repeat(100)) < estimateTokens("x".repeat(1_000)),
);
check(
  "the same text costs more as code than as prose",
  estimateTokens("x".repeat(1_000), "code") > estimateTokens("x".repeat(1_000), "prose"),
  `${estimateTokens("x".repeat(1_000), "code")} vs ${estimateTokens("x".repeat(1_000), "prose")}`,
);

console.info("\nBands are derived from the validator's budget, not invented");

check(
  "a body at the oversized-marker budget lands in the oversized band",
  costBand(estimateTokens("x".repeat(MAX_BODY_BYTES))) === "oversized",
  `${MAX_BODY_BYTES} bytes -> ${formatTokens(estimateTokens("x".repeat(MAX_BODY_BYTES)))}`,
);
check(
  "a body at the progressive-disclosure hint lands in the heavy band",
  costBand(estimateTokens("x".repeat(DISCLOSURE_HINT_BYTES))) === "heavy",
  `${DISCLOSURE_HINT_BYTES} bytes -> ${formatTokens(estimateTokens("x".repeat(DISCLOSURE_HINT_BYTES)))}`,
);
check(
  "a body just under the disclosure hint is not yet heavy",
  costBand(estimateTokens("x".repeat(DISCLOSURE_HINT_BYTES - 1_000))) === "typical",
);
/**
 * The `typical` floor is stated as a literal in `tokens.ts` rather than imported from
 * `quality.ts`, to keep one leaf module from importing another for a single constant. That
 * decision is only safe if something notices when they diverge. This is that something.
 */
check(
  "the typical floor still matches quality.ts's substantial-body threshold",
  COST_BANDS.typical === estimateTokens("x".repeat(SUBSTANTIAL_BYTES)),
  `${COST_BANDS.typical} vs ${estimateTokens("x".repeat(SUBSTANTIAL_BYTES))} (SUBSTANTIAL_BYTES ${SUBSTANTIAL_BYTES})`,
);
check(
  "the band floors ascend",
  COST_BANDS.typical < COST_BANDS.heavy && COST_BANDS.heavy < COST_BANDS.oversized,
  `${COST_BANDS.typical} < ${COST_BANDS.heavy} < ${COST_BANDS.oversized}`,
);
check("a tiny body is lean", costBand(1) === "lean");
check(
  "every band has a label and a blurb",
  (["lean", "typical", "heavy", "oversized"] as const).every(
    (b) => COST_BAND_META[b].label.length > 0 && COST_BAND_META[b].blurb.length > 0,
  ),
);

console.info("\nPresentation");

check(
  "the figure is formatted compactly above a thousand",
  formatTokens(999) === "999" && formatTokens(1_819) === "1.8K",
  `${formatTokens(999)}, ${formatTokens(1_819)}`,
);
/**
 * A badge that links into the reference and a reference section that does not exist is the
 * failure `lib/faq.ts` was written to make impossible — but only for anchors that are typed.
 * This asserts the section is actually listed, so the jump navigation renders it too.
 */
check(
  "the FAQ has a section for activation cost",
  FAQ_SECTIONS.some((s) => s.id === "cost"),
  FAQ_SECTIONS.map((s) => s.id).join(", "),
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: totals } = await c.query<{
    rows: string;
    zero: string;
    mismatch: string;
    median: string | null;
  }>(
    `select
       count(*)::text as rows,
       count(*) filter (where token_estimate = 0 and block_count > 0)::text as zero,
       count(*) filter (where token_estimate < block_count)::text as mismatch,
       percentile_cont(0.5) within group (order by token_estimate)::int::text as median
     from skill_structures where extractor_version = $1`,
    [EXTRACTOR_VERSION],
  );
  const t = totals[0];

  if (t.rows === "0") {
    console.info(
      `  skip  no fingerprints at ${EXTRACTOR_VERSION} yet — run pnpm structures --extract`,
    );
  } else {
    check(
      "no fingerprint with blocks reports a zero token estimate",
      t.zero === "0",
      `${t.zero} rows at zero`,
    );
    /**
     * Every block costs at least one token, so the per-version total can never be below the
     * block count. Cheap, and it catches the class of bug where a sum is taken over the
     * wrong collection — which would otherwise look like a plausible smaller number.
     */
    check(
      "every version's estimate is at least its block count",
      t.mismatch === "0",
      `${t.mismatch} below it`,
    );
    console.info(
      `  note  ${t.rows} fingerprints · median ${formatTokens(Number(t.median ?? 0))} tokens` +
        ` · band ${costBand(Number(t.median ?? 0))}`,
    );
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
