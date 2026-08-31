import "dotenv/config";

/**
 * Caps are shrunk to almost nothing before `spend.ts` reads them.
 *
 * It resolves its budgets from the environment at import time, so the exhaustion path can
 * be exercised by spending two micro-dollars instead of the real $50 cap. That matters:
 * the first version of this script spent the whole platform budget for real and then could
 * not clean it up — the ledger has no DELETE policy — which left corpus analysis blocked
 * until it was removed by hand.
 *
 * **The import below must stay dynamic.** ESM hoists every static `import` above
 * module-level statements, so an assignment written here would run *after* `spend.ts` had
 * already read the environment and would silently do nothing. The second version of this
 * script did exactly that and reported the cap as un-exhaustible.
 */
import { Pool } from "pg";
import { sql } from "drizzle-orm";

import { db } from "../src/server/db";
import { organization } from "../src/server/db/schema/auth";
import { withExplicitOrgScope } from "../src/server/dal/scope";
import { costMicros, formatMicros, MODEL_RATES } from "../src/lib/llm-pricing";
import type { BudgetExceededError as BudgetError } from "../src/server/billing/spend";

/**
 * Caps are computed from the **current** month's real spend, not assumed.
 *
 * The first version hard-coded tiny caps and asserted that a fixture crossed the 80%
 * threshold — which passed once and then failed for ever, because a real taxonomy run had
 * already pushed the platform budget past 80% and a crossing only happens once. A test that
 * only works against an empty ledger is a test that works on day one.
 *
 * So: the platform cap is set below existing spend (already exhausted, exercising the
 * refusal), and the org cap is set so that this run's own fixture is what crosses the
 * threshold. Both are derived here, before the dynamic import below reads them.
 */
const probe = new Pool({ connectionString: process.env.DATABASE_URL });
const monthStartSql = "date_trunc('month', now() at time zone 'utc')";
const baseline = await probe.query(
  `select
     coalesce(sum(cost_micros) filter (where org_id is null), 0)::bigint as platform,
     coalesce(sum(cost_micros) filter (where org_id is not null), 0)::bigint as org
   from llm_usage where at >= ${monthStartSql}`,
);
await probe.end();
const orgBaseline = Number(baseline.rows[0].org);

// Exhausted by construction: any existing platform spend exceeds two micro-dollars, and a
// zero baseline is still met by this run's own two-micro fixture.
process.env.LLM_PLATFORM_MONTHLY_CAP_USD = "0.000002";
/**
 * Sized so the fixture below lands *comfortably* past 80%, not exactly on it.
 *
 * The first version aimed for the threshold precisely — cap = `baseline × 1.25 + 10`, so
 * the boundary sat at `baseline + 8` and an eight-micro fixture met it. Rounding the cap to
 * an integer moved the boundary a fraction of a micro-dollar upward and the crossing
 * silently stopped firing. A test that depends on hitting a float boundary exactly is a
 * test that fails the first time the baseline changes.
 */
const ORG_CAP_MICROS_TARGET = Math.round(orgBaseline * 1.25 + 10);
const CROSSING_FIXTURE_MICROS = 20;
process.env.LLM_ORG_MONTHLY_CAP_USD = String(ORG_CAP_MICROS_TARGET / 1_000_000);

const {
  assertWithinBudget,
  budgetState,
  BudgetExceededError,
  ORG_MONTHLY_CAP_MICROS,
  PLATFORM_MONTHLY_CAP_MICROS,
  recordUsage,
  tokensFrom,
} = await import("../src/server/billing/spend");

/**
 * Proves the spend caps (Doc 2 RC.2) and the metering under them (RC.3).
 *
 *   pnpm verify:spend
 *
 * **Free — no model is called.** That is the point: a budget is arithmetic and a refusal,
 * and both are testable without spending anything. A test that had to burn real money to
 * check a spend cap would be self-defeating.
 *
 * The properties, in the order they would fail in production:
 *
 *   1. cost arithmetic is right, including the cache multipliers — a cap enforced against
 *      wrong numbers is not a cap;
 *   2. the two budgets are separate, so corpus work cannot exhaust a customer's allowance
 *      and vice versa;
 *   3. `assertWithinBudget` **throws** once a budget is spent, rather than warning;
 *   4. the refusal carries the numbers a user needs.
 *
 * Fixtures are written against a scratch organisation-free platform purpose and a real org,
 * then deleted. Nothing here charges anyone.
 */

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const MARKER = `spendfix-${Date.now()}`;

// --- Cost arithmetic ---------------------------------------------------------
{
  // Sonnet 5: $2 in / $10 out per MTok. One million of each, no caching.
  const plain = costMicros("anthropic/claude-sonnet-5", {
    inputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1_000_000,
  });
  check(
    "a million in and out prices at the published rate",
    plain === 12_000_000,
    `${plain} micros, expected 12,000,000 ($12.00 = $2 in + $10 out)`,
  );

  /**
   * Cache multipliers, which are the easy thing to get wrong.
   *
   * Reads are a tenth of the input rate and writes are 1.25×. Charging every input token at
   * the base rate would overstate a cached workload by roughly ten times on the read side —
   * and the taxonomy classifier is mostly cache reads.
   */
  const cached = costMicros("anthropic/claude-sonnet-5", {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 1_000_000,
    outputTokens: 0,
  });
  check(
    "cache reads are charged at a tenth of the input rate",
    cached === 200_000,
    `${cached} micros, expected 200,000 ($0.20 = $2 × 0.1)`,
  );

  const written = costMicros("anthropic/claude-sonnet-5", {
    inputTokens: 0,
    cacheWriteTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
  check(
    "cache writes are charged at 1.25× the input rate",
    written === 2_500_000,
    `${written} micros, expected 2,500,000`,
  );

  // An unlisted model must cost *more* than a known one, never less.
  const unknown = costMicros("someone/new-model", {
    inputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
  const haiku = costMicros("anthropic/claude-haiku-4.5", {
    inputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
  check(
    "an unrecognised model over-charges rather than under-charges",
    unknown > haiku,
    `unknown=${unknown} is not greater than haiku=${haiku}`,
  );

  check(
    "the rate table covers every model the app actually calls",
    Boolean(MODEL_RATES["anthropic/claude-sonnet-5"]) &&
      Boolean(MODEL_RATES["anthropic/claude-haiku-4.5"]),
    "a model used in the codebase has no published rate",
  );
}

// --- The SDK's usage shape is read correctly ---------------------------------
{
  // `inputTokens` is the TOTAL; charging it alongside the cache details double-bills.
  const tokens = tokensFrom({
    inputTokens: 1000,
    outputTokens: 200,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 },
  });
  check(
    "the cached portion of input is not billed twice",
    tokens.inputTokens === 100 && tokens.cacheReadTokens === 800,
    `input=${tokens.inputTokens} (expected 100), read=${tokens.cacheReadTokens}`,
  );

  // When the provider omits the breakdown, the remainder is derived rather than lost.
  const derived = tokensFrom({
    inputTokens: 1000,
    outputTokens: 0,
    inputTokenDetails: { cacheReadTokens: 600 },
  });
  check(
    "a missing breakdown derives the uncached remainder instead of under-counting",
    derived.inputTokens === 400,
    `input=${derived.inputTokens}, expected 400`,
  );
}

// --- The two budgets are separate --------------------------------------------
const [org] = await db.select({ id: organization.id }).from(organization).limit(1);
if (!org) {
  console.info("\n  No organisation yet — sign in once, then re-run.\n");
  process.exit(failures > 0 ? 1 : 0);
}

{
  const before = await budgetState("builder", org.id);
  const platformBefore = await budgetState("corpus_taxonomy", null);

  // Two micro-dollars of platform spend, which exhausts the shrunken cap set above.
  await recordUsage({
    purpose: "corpus_taxonomy",
    orgId: null,
    model: "anthropic/claude-haiku-4.5",
    usage: { inputTokens: 2, outputTokens: 0, inputTokenDetails: { noCacheTokens: 2 } },
    subjectType: MARKER,
  });

  const orgAfter = await budgetState("builder", org.id);
  check(
    "platform spend does not touch an organisation's allowance",
    orgAfter.spentMicros === before.spentMicros,
    `org spend moved from ${before.spentMicros} to ${orgAfter.spentMicros}`,
  );

  const platformAfter = await budgetState("corpus_taxonomy", null);
  check(
    "platform spend is recorded against the platform budget",
    platformAfter.spentMicros > platformBefore.spentMicros,
    `platform spend did not move`,
  );
  check(
    "the two budgets have their own caps",
    orgAfter.capMicros === ORG_MONTHLY_CAP_MICROS &&
      platformAfter.capMicros === PLATFORM_MONTHLY_CAP_MICROS,
    `org cap=${orgAfter.capMicros}, platform cap=${platformAfter.capMicros}`,
  );
}

// --- Fail-closed: it throws, it does not warn --------------------------------
{
  let threw: BudgetError | null = null;
  try {
    await assertWithinBudget("corpus_taxonomy", null);
  } catch (error) {
    if (error instanceof BudgetExceededError) threw = error;
  }

  check(
    "an exhausted budget refuses the call rather than allowing it",
    threw !== null,
    "assertWithinBudget returned instead of throwing",
  );

  if (threw) {
    // RC.2 asks for clear UX. A refusal a user cannot act on is the least clear failure.
    check(
      "the refusal names the cap and when it resets",
      threw.message.includes(formatMicros(PLATFORM_MONTHLY_CAP_MICROS)) &&
        /\d{4}-\d{2}-\d{2}/.test(threw.message),
      threw.message,
    );
  }

  // The org budget is untouched by the platform's exhaustion.
  let orgRefused = false;
  try {
    await assertWithinBudget("builder", org.id);
  } catch {
    orgRefused = true;
  }
  check(
    "one budget being spent does not refuse work on the other",
    !orgRefused,
    "an org call was refused because the platform budget was spent",
  );
}

// --- The alert fires on the crossing, and only on the crossing ---------------
{
  /**
   * Twenty micro-dollars against a cap sized so this is the crossing.
   *
   * The crossing is the news, not the state — so this also checks that a *second* charge
   * past the same threshold does not write a duplicate. An alert that repeats on every call
   * after 80% is an alert an operator learns to ignore.
   */
  await recordUsage({
    purpose: "builder",
    orgId: org.id,
    model: "anthropic/claude-haiku-4.5",
    usage: {
      inputTokens: CROSSING_FIXTURE_MICROS,
      outputTokens: 0,
      inputTokenDetails: { noCacheTokens: CROSSING_FIXTURE_MICROS },
    },
    subjectType: MARKER,
  });

  /**
   * Read inside the org's scope, because the alert is org-scoped.
   *
   * `events` carries the standard org policy, so an unscoped read simply does not see a
   * row written against an organisation — the first version of this check reported "0
   * events" for an alert that had been written correctly. Worth knowing beyond the test:
   * a per-workspace spend alert is visible to that workspace, not to an unscoped operator
   * query.
   */
  const countAlerts = async () => {
    const [row] = await withExplicitOrgScope(org.id, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(sql`events`)
        .where(
          sql`kind in ('spend.threshold', 'spend.cap_reached') and at > now() - interval '2 minutes'`,
        ),
    );
    return row.n;
  };

  const first = { n: await countAlerts() };
  check(
    "crossing a budget threshold writes an audit event",
    first.n === 1,
    `${first.n} spend event(s) after the crossing, expected exactly 1`,
  );

  await recordUsage({
    purpose: "builder",
    orgId: org.id,
    model: "anthropic/claude-haiku-4.5",
    usage: { inputTokens: 1, outputTokens: 0, inputTokenDetails: { noCacheTokens: 1 } },
    subjectType: MARKER,
  });

  const second = { n: await countAlerts() };
  check(
    "staying over the threshold does not re-alert",
    second.n === 1,
    `${second.n} spend event(s) — the alert repeated`,
  );
}

/**
 * Cleanup runs as the database owner, because the application genuinely cannot do it.
 *
 * `llm_usage` has SELECT and INSERT policies and no DELETE policy — deliberately. It is a
 * billing ledger, and RC.3 wants a bill reconstructible from it; an application that can
 * delete its own charges does not have an audit trail. A delete from `app_runtime` is
 * silently refused by RLS, which is how the first run of this script left $50 of fixture
 * spend behind and blocked corpus analysis until it was removed by hand.
 *
 * So maintenance goes where maintenance goes: `DATABASE_URL_UNPOOLED`, the owner connection
 * migrations already use.
 */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await owner.query("delete from llm_usage where subject_type = $1", [MARKER]);
await owner.query(
  "delete from events where kind like 'spend.%' and at > now() - interval '5 minutes'",
);
await owner.end();

console.info(failures === 0 ? "\nSpend caps verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
