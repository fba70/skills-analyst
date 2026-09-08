/**
 * What a conversation is allowed to cost, and how long it is allowed to run (plan step C2a).
 *
 * ## The problem this exists to answer
 *
 * Every model call in this codebase has been one-shot: the classifier labels a skill, the
 * builder writes a draft, the consistency analyzer audits a bundle, the embedder embeds a
 * summary. `assertWithinBudget` is checked immediately before each one, and that is a
 * complete design when the unit of work and the unit of spend are the same thing.
 *
 * Interview mode (RW.4) breaks that. A twenty-turn conversation is twenty calls against the
 * `$5` default org cap, and each turn re-sends the transcript — so cost grows with the
 * *square* of the conversation, not with its length. Checked only per call, the first
 * eighteen turns pass and the nineteenth refuses, which is the worst possible place to stop
 * someone who is halfway through explaining how they actually do their job.
 *
 * The plan flagged this as a decision to make deliberately rather than discover, and named
 * three options: reserve a session budget up front, cap turns, or check per turn.
 *
 * ## What was chosen, and why the other two lose
 *
 * **Not reservation.** Holding micro-dollars before spending them needs a reservation ledger
 * and, worse, a release path — a conversation abandoned in a closed tab holds budget until
 * something sweeps it, and a sweep that fails takes money from a customer who never spent
 * it. `spend.ts` already rejected reservation for a single call on the grounds that it is a
 * lot of machinery for a bounded overshoot; the machinery gets worse here, not better.
 *
 * **Not a turn cap alone.** Turns are not money. A transcript that grows every turn makes
 * the tenth call several times the price of the first, so a number of turns is a proxy for
 * cost that is wrong by a factor nobody can predict — which is the same mistake as banding
 * archetypes on `quality_score`, or reporting archetype-readiness in skills when the gate
 * counts structures. A gate measured with something that is not the gate.
 *
 * **A per-conversation cap, checked per turn, and shown from the first turn.** The cap is
 * real money, derived from the ledger the same way every other budget is. What makes
 * refusing mid-conversation acceptable is that the author is never surprised by it: the
 * remaining budget travels with every turn, so it is a fuel gauge rather than a wall.
 *
 * A turn cap exists *as well*, and is honest about being a different thing — it bounds the
 * transcript growth that makes cost superlinear, and it is labelled as a length limit rather
 * than as a budget.
 *
 * ## Two caps, for the same reason there are already two
 *
 * RC.2 separates the org cap from the platform cap because one customer must not be able to
 * halt corpus analysis. This adds a third level for the same shape of reason one level down:
 * one runaway conversation must not consume a workspace's entire month. The conversation cap
 * is the *smaller* of its own ceiling and what the organisation has left, so it can never
 * authorise spend the org cap would refuse.
 *
 * ## A leaf module, for the fifth-and-more time
 *
 * The interview surface is a client component and `src/server/**` is `server-only`, so the
 * numbers and their formatting live here. Same split as `dialects.ts`, `quality.ts`,
 * `capabilities.ts`, `block-types.ts`, `draft-blocks.ts` and `models.ts`.
 */

/**
 * The most one conversation may spend, in micro-dollars. $0.50.
 *
 * Sized against the thing it bounds rather than picked round: a Sonnet interview turn with a
 * few thousand tokens of transcript runs on the order of a cent, so this is roughly fifty
 * turns of headroom against a thirty-turn ceiling — generous enough that a normal
 * conversation never sees it, tight enough that a loop cannot eat a tenth of the org's month
 * in one session.
 */
export const CONVERSATION_CAP_MICROS = 500_000;

/**
 * The most turns one conversation may take.
 *
 * A bound on shape, not on money, and it says so wherever it is shown. Its job is the
 * superlinear growth: every turn re-sends the transcript, so turn forty is not forty times
 * turn one, it is far worse. Thirty is past the point where an interview is still eliciting
 * rather than circling — RW.4's five techniques are a handful of turns each.
 */
export const CONVERSATION_MAX_TURNS = 30;

/**
 * Below this, a conversation is not started at all.
 *
 * Starting one with a hundredth of a cent left produces a session that greets the author and
 * immediately refuses, which is a worse answer than declining up front — and it costs a call
 * to deliver. The number is a couple of turns' room: enough that starting means finishing
 * something.
 */
export const CONVERSATION_MIN_START_MICROS = 20_000;

export type ConversationBudget = {
  /** Micro-dollars this conversation has already spent, from the ledger. */
  spentMicros: number;
  /** Its ceiling: the lesser of `CONVERSATION_CAP_MICROS` and what the org has left. */
  capMicros: number;
  remainingMicros: number;
  /** 0–100, clamped. For a gauge. */
  usedPercent: number;
  turns: number;
  turnsRemaining: number;
  /**
   * Why the next turn would be refused, or null.
   *
   * Three reasons rather than a boolean, because they are three different things to tell an
   * author: the workspace is out of money for the month, this conversation has used its
   * share, or the conversation has simply gone on long enough. Only the first is a billing
   * problem, and only the third is fixed by starting a new one.
   */
  blockedBy: ConversationBlock | null;
};

export const CONVERSATION_BLOCKS = ["organisation", "conversation", "turns"] as const;

export type ConversationBlock = (typeof CONVERSATION_BLOCKS)[number];

/**
 * What to tell the author. Each names the way out, because a refusal they cannot act on is
 * the least clear failure there is — RC.2's own words about the org cap, one level down.
 */
export function conversationBlockMessage(
  block: ConversationBlock,
  resetsAt: Date,
): string {
  switch (block) {
    case "organisation":
      return (
        `This workspace has used its monthly AI budget. It resets on ` +
        `${resetsAt.toISOString().slice(0, 10)}. Everything said so far is saved.`
      );
    case "conversation":
      return (
        "This conversation has used its budget. Start a new one to carry on — the blocks " +
        "you have accepted are already on the draft."
      );
    case "turns":
      return (
        `A conversation runs to ${CONVERSATION_MAX_TURNS} turns. Start a new one to carry ` +
        "on; nothing is lost."
      );
  }
}

/** `$0.0123` — a conversation's spend is small enough that cents would round it to nothing. */
export function formatConversationSpend(micros: number): string {
  if (micros === 0) return "$0";
  const dollars = micros / 1_000_000;
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}
