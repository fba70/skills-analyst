import "server-only";

import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { events, llmUsage } from "@/server/db/schema";
import { db, type Db } from "@/server/db";
import { costMicros, formatMicros, type TokenCounts } from "@/lib/llm-pricing";

/**
 * Spend caps (Doc 2 RC.2), fail-closed.
 *
 * Two budgets, because RC.2 asks for two and they protect different things:
 *
 *  - a **per-organisation monthly cap** on the assistant and validation, which stops one
 *    customer running up an unbounded bill;
 *  - a **separate global platform budget** for corpus-analyzer spend, which stops our own
 *    batch work doing the same — and which must not be consumable by customers, or a busy
 *    month of authoring would silently halt corpus analysis.
 *
 * Mixing them into one number would let either failure cause the other.
 *
 * ## Fail-closed means refusing, not degrading
 *
 * `assertWithinBudget` throws before the model is called. There is no "try a cheaper model"
 * fallback and no soft warning that still spends: a cap that can be exceeded is a
 * suggestion. RC.2 also asks for *clear UX*, which is why the refusal carries the numbers —
 * what the cap is, what has been spent, when it resets — rather than a generic error.
 *
 * ## The check is before, the ledger is after
 *
 * Cost is only knowable once the call returns, so the pre-check uses the month's spend so
 * far. A single call can therefore carry the total slightly past the cap; the next one is
 * refused. The alternative — estimating tokens up front and reserving them — is a lot of
 * machinery to avoid one overshoot bounded by the cost of a single call, and it would
 * refuse work whenever the estimate ran high.
 *
 * ## Configured by environment, deliberately
 *
 * The knobs live in `policy`-style constants read from the environment rather than in a
 * settings table. CLAUDE.md's standing note says policy becomes data eventually; a spend
 * cap is the one knob where a bad value is expensive in both directions, so it stays
 * somewhere a deploy has to change it until there is an audited admin path.
 */

/** Micro-dollars per organisation per calendar month. Default $5. */
export const ORG_MONTHLY_CAP_MICROS = readMicros("LLM_ORG_MONTHLY_CAP_USD", 5);

/** Micro-dollars of corpus-analyzer spend per calendar month. Default $50. */
export const PLATFORM_MONTHLY_CAP_MICROS = readMicros("LLM_PLATFORM_MONTHLY_CAP_USD", 50);

/** Share of a budget at which an alert event is written. RC.2 asks for alerting. */
const ALERT_AT = 0.8;

function readMicros(key: string, fallbackDollars: number): number {
  const raw = Number(process.env[key]);
  const dollars = Number.isFinite(raw) && raw > 0 ? raw : fallbackDollars;
  return Math.round(dollars * 1_000_000);
}

/** Purposes billed to an organisation. The rest are platform work. */
const ORG_PURPOSES = ["builder", "validation"] as const;
export type LlmPurpose = (typeof ORG_PURPOSES)[number] | "corpus_taxonomy" | "corpus_validation";

const isOrgPurpose = (purpose: LlmPurpose): boolean =>
  (ORG_PURPOSES as readonly string[]).includes(purpose);

/** First instant of the current calendar month, UTC. The window RC.2 specifies. */
function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of next month — what a refusal tells the user to wait for. */
function nextMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export type BudgetState = {
  scope: "organisation" | "platform";
  spentMicros: number;
  capMicros: number;
  remainingMicros: number;
  /** 0–100, clamped. For a progress bar and the alert threshold. */
  usedPercent: number;
  resetsAt: Date;
};

/**
 * What has been spent this month against the budget a purpose belongs to.
 *
 * Reads unscoped: the platform sum spans every row by definition, and the per-org sum is
 * filtered by an explicit `where` rather than by RLS. See the migration note — the read
 * policy is open because the columns cannot carry request content.
 */
export async function budgetState(
  purpose: LlmPurpose,
  orgId: string | null,
): Promise<BudgetState> {
  const since = monthStart();
  const orgScoped = isOrgPurpose(purpose) && orgId !== null;

  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${llmUsage.costMicros}), 0)::bigint` })
    .from(llmUsage)
    .where(
      and(
        gte(llmUsage.at, since),
        orgScoped ? eq(llmUsage.orgId, orgId) : isNull(llmUsage.orgId),
      ),
    );

  const spentMicros = Number(row?.spent ?? 0);
  const capMicros = orgScoped ? ORG_MONTHLY_CAP_MICROS : PLATFORM_MONTHLY_CAP_MICROS;

  return {
    scope: orgScoped ? "organisation" : "platform",
    spentMicros,
    capMicros,
    remainingMicros: Math.max(0, capMicros - spentMicros),
    usedPercent: Math.min(100, Math.round((spentMicros / capMicros) * 100)),
    resetsAt: nextMonthStart(),
  };
}

/** Thrown instead of calling a model. Carries the numbers a caller should show. */
export class BudgetExceededError extends Error {
  constructor(readonly state: BudgetState) {
    super(
      state.scope === "organisation"
        ? `This workspace has used its ${formatMicros(state.capMicros)} monthly AI budget. ` +
            `It resets on ${state.resetsAt.toISOString().slice(0, 10)}.`
        : `The platform's ${formatMicros(state.capMicros)} monthly analysis budget is spent. ` +
            `It resets on ${state.resetsAt.toISOString().slice(0, 10)}.`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Refuses before spending. Call immediately before every model call.
 *
 * Throwing rather than returning a flag is the point: a caller that forgets to check a
 * boolean spends money, while a caller that forgets to call this at all is a missing line
 * that shows up in review. Neither is perfect; the throw fails in the safer direction.
 */
export async function assertWithinBudget(
  purpose: LlmPurpose,
  orgId: string | null,
): Promise<BudgetState> {
  const state = await budgetState(purpose, orgId);
  if (state.remainingMicros <= 0) throw new BudgetExceededError(state);
  return state;
}

/** The AI SDK's usage shape, narrowed to what pricing needs. */
export type SdkUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

/**
 * Turns the SDK's usage into the counts pricing expects.
 *
 * `inputTokens` is the **total**, so charging it alongside the cache details would bill the
 * cached portion twice. `noCacheTokens` is the full-rate part; when the provider does not
 * report the breakdown, the remainder is derived so a call is never under-counted.
 */
export function tokensFrom(usage: SdkUsage | undefined): TokenCounts {
  const details = usage?.inputTokenDetails ?? {};
  const cacheRead = details.cacheReadTokens ?? 0;
  const cacheWrite = details.cacheWriteTokens ?? 0;
  const total = usage?.inputTokens ?? 0;
  const uncached = details.noCacheTokens ?? Math.max(0, total - cacheRead - cacheWrite);

  return {
    inputTokens: uncached,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

/**
 * Writes one ledger row, and an alert event when a budget crosses its threshold.
 *
 * Never throws. A call that succeeded and could not be metered is a bookkeeping problem;
 * turning it into a user-visible failure would mean the customer paid for a result they did
 * not receive. The warning is loud instead, because silent under-metering is how a cap
 * quietly stops working.
 */
export async function recordUsage(input: {
  purpose: LlmPurpose;
  orgId: string | null;
  model: string;
  usage: SdkUsage | undefined;
  subjectType?: string;
  subjectId?: string;
}): Promise<number> {
  const tokens = tokensFrom(input.usage);
  const cost = costMicros(input.model, tokens);
  const orgScoped = isOrgPurpose(input.purpose) && input.orgId !== null;

  /**
   * Org-scoped rows must be written inside the org's scope.
   *
   * The write policy is `org_id IS NULL OR org_id = current_setting('app.org_id')`, so a
   * charge against an organisation inserted from an unscoped handle is **refused by RLS** —
   * and because this function deliberately swallows its own failures, that refusal is a
   * warning in a log rather than an error anyone sees. The first version did exactly that:
   * every builder call was silently unmetered, which meant the per-org cap could never be
   * reached and RC.2 was satisfied on paper only. Platform rows carry no org and need no
   * scope, which is why the two paths differ.
   */
  const write = async (run: (client: Db) => Promise<unknown>) => {
    if (!orgScoped || !input.orgId) return run(db);
    const { withExplicitOrgScope } = await import("@/server/dal/scope");
    return withExplicitOrgScope(input.orgId, (tx) => run(tx));
  };

  try {
    await write((client) => client.insert(llmUsage).values({
      orgId: orgScoped ? input.orgId : null,
      purpose: input.purpose,
      model: input.model,
      inputTokens: tokens.inputTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      outputTokens: tokens.outputTokens,
      costMicros: cost,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
    }));

    /**
     * RC.2's alerting, as an audit event rather than a channel.
     *
     * Written when the budget crosses the threshold, not every call after it — the crossing
     * is the news. `events` is where every other state transition lands (R7.1), so an
     * operator reading the audit log sees the budget alongside everything else rather than
     * needing a second place to look.
     */
    const state = await budgetState(input.purpose, input.orgId);
    const before = state.spentMicros - cost;
    const threshold = state.capMicros * ALERT_AT;
    if (before < threshold && state.spentMicros >= threshold) {
      await write((client) => client.insert(events).values({
        orgId: orgScoped ? input.orgId : null,
        actorType: "system",
        actorId: "billing.spend",
        kind: state.spentMicros >= state.capMicros ? "spend.cap_reached" : "spend.threshold",
        subjectType: "llm_usage",
        reason: `${state.scope} spend at ${state.usedPercent}% of ${formatMicros(state.capMicros)}`,
        payload: {
          scope: state.scope,
          spentMicros: state.spentMicros,
          capMicros: state.capMicros,
          purpose: input.purpose,
        },
      }));
    }
  } catch (error) {
    console.warn(
      `[spend] usage not recorded (${input.purpose}, ${input.model}): ${(error as Error).message}`,
    );
  }

  return cost;
}

/** Per-purpose breakdown for the settings panel. */
export async function spendBreakdown() {
  const since = monthStart();
  const rows = await db
    .select({
      purpose: llmUsage.purpose,
      calls: sql<number>`count(*)::int`,
      cost: sql<number>`coalesce(sum(${llmUsage.costMicros}), 0)::bigint`,
    })
    .from(llmUsage)
    .where(gte(llmUsage.at, since))
    .groupBy(llmUsage.purpose);

  return rows.map((row) => ({
    purpose: row.purpose,
    calls: row.calls,
    costMicros: Number(row.cost),
  }));
}
