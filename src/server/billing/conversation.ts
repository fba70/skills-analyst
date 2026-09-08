import "server-only";

import { and, eq, sql } from "drizzle-orm";

import {
  CONVERSATION_CAP_MICROS,
  CONVERSATION_MAX_TURNS,
  CONVERSATION_MIN_START_MICROS,
  conversationBlockMessage,
  type ConversationBlock,
  type ConversationBudget,
} from "@/lib/conversation";
import { db } from "@/server/db";
import { llmUsage } from "@/server/db/schema";

import { budgetState } from "./spend";

/**
 * What one conversation has spent, and whether it may take another turn (plan step C2a).
 *
 * ## No new table, and that is the design
 *
 * A conversation's spend is not a new fact — it is the rows the conversation's own turns
 * already wrote. `llm_usage` carries `subject_type` and `subject_id` on every row precisely
 * so a charge can be traced back to the thing that caused it, and a conversation is a thing.
 * So the budget is a `sum(cost_micros) where subject_id = <conversation>`, computed the same
 * way the org and platform budgets are.
 *
 * A counter column would have been the obvious alternative and would be a second source of
 * truth for a number the ledger already holds — the exact shape `db:audit` was rewritten to
 * stop reporting, and the shape `outcome_signals` avoids by making the unique index *be* the
 * deduplicated count rather than maintaining one beside it.
 *
 * It also means C2a needs no migration at all. The conversation id is whatever the caller
 * uses; C2b gives it a row of its own, and this module does not change when it does.
 *
 * ## The conversation cap can never authorise what the org cap refuses
 *
 * `capMicros` is the *lesser* of the conversation ceiling and what the organisation has left
 * this month. A fixed ceiling would let a workspace with 20¢ remaining start a conversation
 * advertising 50¢, and the author would watch a gauge that was lying to them from turn one.
 *
 * ## Fail-closed, unlike the rate limiter
 *
 * `rate-limits.ts` fails open, deliberately, because a counter table blinking must not take
 * the public registry dark over data that is public and read-only. This is the opposite
 * case and takes the opposite posture: it is spending money, and a budget that cannot read
 * its own ledger has no idea what it is authorising. Same reasoning as `publicWrite`, which
 * inverted the read scopes for the same kind of reason.
 */

export type ConversationBudgetInput = {
  conversationId: string;
  orgId: string;
  /** Turns already taken. Supplied by the caller, which is the thing that counts them. */
  turns: number;
};

/**
 * The subject a conversation's ledger rows carry.
 *
 * One constant, used by the reader here and by the writer in the streaming seam, because a
 * budget that summed a different `subject_type` from the one the calls record would report
 * every conversation as free — and it would report it consistently, which is why this is a
 * constant rather than two string literals in two files.
 */
export const CONVERSATION_SUBJECT = "conversation";

export async function conversationBudget(
  input: ConversationBudgetInput,
): Promise<ConversationBudget> {
  const org = await budgetState("builder", input.orgId);

  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${llmUsage.costMicros}), 0)::bigint` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.subjectType, CONVERSATION_SUBJECT),
        eq(llmUsage.subjectId, input.conversationId),
      ),
    );

  const spentMicros = Number(row?.spent ?? 0);
  /*
   * The lesser of the two ceilings, and never below what has already been spent.
   *
   * The clamp matters on the last turn of a conversation that pushed the org over: without
   * it, `capMicros` could come back smaller than `spentMicros` and the gauge would render
   * past its own end. The refusal is decided below on both budgets independently, so
   * clamping the display cannot hide a real block.
   */
  const capMicros = Math.max(
    spentMicros,
    Math.min(CONVERSATION_CAP_MICROS, spentMicros + org.remainingMicros),
  );
  const remainingMicros = Math.max(0, capMicros - spentMicros);
  const turnsRemaining = Math.max(0, CONVERSATION_MAX_TURNS - input.turns);

  /*
   * Ordered by consequence, not by likelihood. "The workspace is out of money" outranks the
   * other two because it is the only one that is not fixed by starting a new conversation,
   * and telling somebody to start a fresh session when the month's budget is gone would send
   * them round a loop that cannot end.
   */
  let blockedBy: ConversationBlock | null = null;
  if (org.remainingMicros <= 0) blockedBy = "organisation";
  else if (remainingMicros <= 0) blockedBy = "conversation";
  else if (turnsRemaining <= 0) blockedBy = "turns";

  return {
    spentMicros,
    capMicros,
    remainingMicros,
    usedPercent: capMicros > 0 ? Math.min(100, Math.round((spentMicros / capMicros) * 100)) : 0,
    turns: input.turns,
    turnsRemaining,
    blockedBy,
  };
}

/** Thrown instead of taking a turn. Carries the state so a caller can render the gauge. */
export class ConversationBudgetError extends Error {
  constructor(
    readonly budget: ConversationBudget,
    readonly block: ConversationBlock,
    resetsAt: Date,
  ) {
    super(conversationBlockMessage(block, resetsAt));
    this.name = "ConversationBudgetError";
  }
}

/**
 * Refuses before the turn. Call immediately before every conversational model call.
 *
 * Throws rather than returning a flag, exactly as `assertWithinBudget` does and for the
 * same reason: a caller that forgets to read a boolean spends money, while a caller that
 * forgets this line is a missing statement a reviewer can see.
 *
 * It does **not** replace `assertWithinBudget` — it subsumes it, by reading the org budget
 * as one of its three conditions. A call site that checked only this one would still be
 * refused when the workspace runs out, which is the property that matters; the streaming
 * seam calls this and nothing else so there is one gate rather than two that can disagree.
 */
export async function assertConversationBudget(
  input: ConversationBudgetInput,
): Promise<ConversationBudget> {
  const budget = await conversationBudget(input);
  if (budget.blockedBy) {
    const org = await budgetState("builder", input.orgId);
    throw new ConversationBudgetError(budget, budget.blockedBy, org.resetsAt);
  }
  return budget;
}

/**
 * Whether a conversation is worth starting at all.
 *
 * Separate from the per-turn gate because it answers a different question at a different
 * moment. Starting a session with a hundredth of a cent of room produces one that greets the
 * author and then refuses — and delivering that greeting costs a call. Better to decline on
 * the button than to sell a conversation that cannot happen.
 */
export async function canStartConversation(
  orgId: string,
): Promise<{ ok: true; budget: ConversationBudget } | { ok: false; message: string }> {
  const budget = await conversationBudget({ conversationId: "", orgId, turns: 0 });
  if (budget.remainingMicros < CONVERSATION_MIN_START_MICROS) {
    const org = await budgetState("builder", orgId);
    return { ok: false, message: conversationBlockMessage("organisation", org.resetsAt) };
  }
  return { ok: true, budget };
}
