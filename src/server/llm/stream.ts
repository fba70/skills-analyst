import "server-only";

import { Output, streamText, type LanguageModel, type ModelMessage } from "ai";
import type { z } from "zod";

import type { ConversationBudget } from "@/lib/conversation";
import type { ModelTask } from "@/lib/models";
import {
  assertConversationBudget,
  CONVERSATION_SUBJECT,
} from "@/server/billing/conversation";
import type { LlmPurpose } from "@/server/billing/spend";

/**
 * The one way this codebase streams a model call (plan step C2a).
 *
 * ## Why a seam, before any conversation exists
 *
 * All four existing model call sites are one-shot: label a skill, write a draft, audit a
 * bundle, embed a summary. Each awaits a result and meters it, and that is complete while
 * the unit of work and the unit of spend are the same thing.
 *
 * Streaming breaks the assumption that makes it safe, and it breaks it on the money side. A
 * one-shot call cannot finish without the caller learning it finished; a stream can. If the
 * reader walks away — a closed tab, a navigation, a dropped connection — the provider has
 * still generated the tokens and still charges for them, and **a call that spends and is not
 * metered is invisible under-billing**. That is exactly the failure `recordUsage` shipped
 * once: it wrote unscoped, RLS refused every org row, and because that function swallows its
 * own failures the cap could never be reached and RC.2 was satisfied on paper only.
 *
 * So the rule this module enforces: **metering does not depend on the consumer.** The
 * metering promise is started eagerly here and hangs off the SDK's own completion, never off
 * the caller reading `textStream`.
 *
 * ## What `consumeStream()` is actually for, measured rather than assumed
 *
 * This module was written expecting backpressure — nothing pulls, nothing finishes,
 * `totalUsage` never settles. **ai@7 does not behave that way.** `verify:stream` measures it
 * against a genuinely pull-based source: the SDK drains the model stream eagerly, so the
 * usage resolves whether or not anybody reads it.
 *
 * `consumeStream()` therefore stays as a **guard against that changing**, not as a fix for a
 * live hang, and it is worth its line because the check that establishes the fact also
 * watches it: an SDK upgrade that reintroduces backpressure turns `verify:stream` red and
 * names this call as the one that has become critical. Same posture as pinning that an
 * `AbortSignal` survives `AwsClient.sign()`.
 *
 * The honest limit: this covers the *process* continuing to run. A serverless environment
 * that tears down the invocation the moment the client disconnects can still cut the metering
 * off, and no amount of care inside this function changes that — the fix there is a runtime
 * that does not, which Fluid Compute is.
 *
 * ## What it does not do
 *
 * No conversation logic, no prompts, no interview. C2a ships the seam and the budget; RW.4
 * is C2b. The only reason this module knows the word "conversation" at all is that the
 * budget gate is per conversation and the ledger row has to carry the subject the budget
 * sums on — and that string is a shared constant for exactly that reason.
 *
 * ## The overshoot bound moved, and it is worth saying by how much
 *
 * `spend.ts` accepts that a single call can carry a budget slightly past its cap, on the
 * grounds that the overshoot is bounded by one call. That still holds here, but "one call"
 * is now a turn carrying the whole transcript, which is the most expensive call in the
 * conversation rather than an average one. The conversation cap is what keeps that bound
 * small: it is a fraction of the org cap, so the worst overshoot is a fraction of a fraction.
 */

export type StreamMeteredInput = {
  /** Which model setting to resolve. Never a hard-coded id — see `settings/models.ts`. */
  task: ModelTask;
  /** Which budget the spend belongs to. */
  purpose: LlmPurpose;
  orgId: string;
  /** What the budget is summed over, and what the ledger row points at. */
  conversationId: string;
  /** Turns already taken, for the length bound. */
  turns: number;
  system: string;
  messages: ModelMessage[];
  temperature?: number;
};

export type MeteredResult = {
  /** Micro-dollars this turn cost, or 0 when the call failed before producing usage. */
  costMicros: number;
  /** The full assistant text, once the stream has drained. */
  text: string;
  model: string;
  /** Set when the stream errored. The text may still be partial and is still metered. */
  error: string | null;
};

export type MeteredStream = {
  /** The assistant's text as it arrives. Safe to abandon — see the note above. */
  textStream: AsyncIterable<string>;
  /**
   * Resolves once the turn has been metered. **Never rejects.**
   *
   * A rejection here would be a bookkeeping failure surfacing as a user-facing error on a
   * call the customer already paid for, which is the posture `recordUsage` settled on and
   * the heartbeat before it. The error travels in the value instead.
   */
  metered: Promise<MeteredResult>;
  /** The budget as it stood *before* this turn, so a caller can render a gauge immediately. */
  budget: ConversationBudget;
  model: string;
};

/**
 * Stream one turn, budget-checked before and metered after, whatever the reader does.
 *
 * Throws `ConversationBudgetError` before any call when the turn is not allowed. That is the
 * only way it throws: once the provider has been reached, every outcome is a value.
 */
export async function streamMetered(input: StreamMeteredInput): Promise<MeteredStream> {
  const { modelFor } = await import("@/server/settings/models");
  const model = await modelFor(input.task);
  return run(model, model, input);
}

/**
 * Test seam, matching `createForTest`, `generateForTest`, `publishForTest` and `upholdForTest`.
 *
 * Takes a `LanguageModel` object so a suite can inject `ai/test`'s mock and exercise the real
 * budget gate, the real ledger write and the real abandon-the-stream path without spending
 * money — which is the point, because the properties worth checking here are all about what
 * happens when a call goes wrong, and a suite that had to burn tokens to check them would be
 * a suite nobody runs. It skips `modelFor` and **nothing else**.
 *
 * The `modelId` is passed separately because pricing keys on the id string and a mock has no
 * meaningful one; the suite names a real priced id so the cost arithmetic is the real
 * arithmetic.
 */
export const streamMeteredWithModel = (
  model: LanguageModel,
  modelId: string,
  input: StreamMeteredInput,
) => run(model, modelId, input);

async function run(
  model: LanguageModel,
  modelId: string,
  input: StreamMeteredInput,
): Promise<MeteredStream> {
  /*
   * Before the call, and it is one gate rather than two.
   *
   * `assertConversationBudget` reads the organisation's budget as one of its three
   * conditions, so calling `assertWithinBudget` here as well would be a second gate that can
   * disagree with the first — and the one that disagreed would be the one nobody was reading.
   */
  const budget = await assertConversationBudget({
    conversationId: input.conversationId,
    orgId: input.orgId,
    turns: input.turns,
  });

  const result = streamText({
    model,
    system: input.system,
    messages: input.messages,
    temperature: input.temperature ?? 0.4,
  });

  /*
   * Eager and detached.
   *
   * `consumeStream` forces the result stream to completion server-side. Today the SDK already
   * drains the model stream on its own — `verify:stream` measures that — so this is the guard
   * that keeps the guarantee true if it ever stops. Started here rather than inside the
   * promise below so it begins before this function returns: a caller that hands the stream
   * to a client and then crashes has still armed the metering.
   *
   * It does not compete with the caller's own read; the SDK buffers parts, which is why this
   * is the documented way to make a finish callback fire on a disconnected client.
   */
  const metered = meterWhenDrained(result, modelId, input);

  return { textStream: result.textStream, metered, budget, model: modelId };
}

/**
 * The half both paths share: drain, then meter, whatever the reader does.
 *
 * One function rather than a copy in each, because the copy is where the two would drift — and
 * the thing that would drift is which calls reach the ledger. `verify:stream` exercises the
 * text path end to end against the real `llm_usage` table; the object path is the same code.
 */
function meterWhenDrained(
  result: {
    consumeStream: () => PromiseLike<void>;
    totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number }>;
    text: PromiseLike<string>;
  },
  modelId: string,
  input: StreamMeteredInput,
): Promise<MeteredResult> {
  const drained = Promise.resolve(result.consumeStream()).then(
    () => null,
    (error: unknown) => (error as Error)?.message ?? "stream failed",
  );

  const metered: Promise<MeteredResult> = (async () => {
    const error = await drained;
    try {
      const usage = await result.totalUsage;
      const text = await Promise.resolve(result.text).then(
        (value) => value,
        () => "",
      );
      const { recordUsage } = await import("@/server/billing/spend");
      const costMicros = await recordUsage({
        purpose: input.purpose,
        orgId: input.orgId,
        model: modelId,
        usage,
        /*
         * The subject is what makes the conversation budget possible: it is summed over these
         * rows. A shared constant rather than a literal, because a writer and a reader using
         * two different strings would report every conversation as free, consistently.
         */
        subjectType: CONVERSATION_SUBJECT,
        subjectId: input.conversationId,
      });
      return { costMicros, text, model: modelId, error };
    } catch (failure) {
      /*
       * A turn that produced no usage at all — the provider refused, the network died before
       * a first chunk. Nothing was charged, so nothing is metered, and the caller is told.
       * Reported as a value because rejecting would make a bookkeeping path throw into a
       * user's face on a turn they may already have partly received.
       */
      return {
        costMicros: 0,
        text: "",
        model: modelId,
        error: error ?? (failure as Error).message,
      };
    }
  })();

  /*
   * Swallowed here so an abandoned stream cannot become an unhandled rejection that takes the
   * process down — the same class of failure as `pg`'s EventEmitter emitting `error` with
   * nothing listening, which killed a sixty-pass ingestion run at pass 26. The value is still
   * available to a caller that does await it.
   */
  void metered.catch(() => undefined);
  return metered;
}


// ---------------------------------------------------------------------------------------
// Structured streaming (plan step C2b)
// ---------------------------------------------------------------------------------------

export type MeteredObjectStream<T> = {
  /**
   * The object as it fills in. Every field is optional until the stream ends, because a
   * partially-parsed object is exactly that.
   *
   * This is what makes a conversation feel like one: the question appears a few words at a
   * time while the typed candidate blocks after it are still being written. A caller that
   * only wants the finished thing can ignore it and await `output`.
   */
  partialStream: AsyncIterable<unknown>;
  /** The validated object. Rejects if the model never produced a parseable one. */
  output: Promise<T>;
  metered: Promise<MeteredResult>;
  budget: ConversationBudget;
  model: string;
};

/**
 * One turn that returns a structured object, streamed and metered (plan step C2b).
 *
 * ## Why this is `streamText` with an output spec rather than `streamObject`
 *
 * An interview turn is two things at once — a question to show the author, and typed candidate
 * blocks to offer them — so it has to be one structured result rather than prose. `streamObject`
 * would do that, and it would be a **second streaming path**: a second budget gate, a second
 * place `consumeStream` has to be remembered, a second thing to forget when metering changes.
 *
 * `streamText` with `output: Output.object(...)` gives the same structured result through the
 * same function, so `verify:stream`'s "streamText is called in one place" check keeps meaning
 * what it says. `partialOutputStream` is the progressive view.
 *
 * Everything else — the gate before, the eager drain, the metering that does not depend on the
 * reader — is the shared helper below, unchanged.
 */
export async function streamMeteredObject<T>(
  input: StreamMeteredInput & { schema: z.ZodType<T> },
): Promise<MeteredObjectStream<T>> {
  const { modelFor } = await import("@/server/settings/models");
  const model = await modelFor(input.task);
  return runObject(model, model, input);
}

/** Test seam, matching `streamMeteredWithModel`. Skips `modelFor` and nothing else. */
export const streamMeteredObjectWithModel = <T>(
  model: LanguageModel,
  modelId: string,
  input: StreamMeteredInput & { schema: z.ZodType<T> },
) => runObject(model, modelId, input);

async function runObject<T>(
  model: LanguageModel,
  modelId: string,
  input: StreamMeteredInput & { schema: z.ZodType<T> },
): Promise<MeteredObjectStream<T>> {
  const budget = await assertConversationBudget({
    conversationId: input.conversationId,
    orgId: input.orgId,
    turns: input.turns,
  });

  const result = streamText({
    model,
    system: input.system,
    messages: input.messages,
    temperature: input.temperature ?? 0.4,
    output: Output.object({ schema: input.schema }),
  });

  const metered = meterWhenDrained(result, modelId, input);

  return {
    partialStream: result.partialOutputStream,
    output: result.output as Promise<T>,
    metered,
    budget,
    model: modelId,
  };
}
