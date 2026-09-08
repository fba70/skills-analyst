import "server-only";

import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { BLOCK_TYPES } from "@/lib/block-types";
import { MAX_CANDIDATES_PER_TURN, type InterviewTechnique } from "@/lib/interview";
import { withExplicitOrgScope } from "@/server/dal/scope";
import {
  interviewCandidates,
  interviewSessions,
  interviewTurns,
  skillDrafts,
} from "@/server/db/schema";
import { streamMeteredObject, type MeteredResult } from "@/server/llm/stream";
import { labelFor } from "@/server/taxonomy/vocabulary";

import { conversationIdFor, endSession } from "./session";
import { draftContext, techniqueSystem } from "./techniques";

/**
 * One interview turn: a question, and typed candidate blocks (Doc 6 RW.4, plan step C2b).
 *
 * ## A turn is one model call, not two
 *
 * The obvious shape is to stream a question and then, separately, ask a model to extract
 * blocks from the author's answer. That is two calls, twice the money, and — worse — the
 * second one has to re-read the transcript to know what the first was driving at. One
 * structured result does both, and `streamMeteredObject` streams it so the question appears
 * while the blocks are still being written.
 *
 * ## The author's turn is committed before the model is called
 *
 * The same order `createDraft` established and for the same reason: a call that fails or is
 * refused must cost the answer, never the author's typing. Somebody four hundred words into
 * describing an exception they have never written down will not type it twice.
 */

const turnSchema = z.object({
  question: z
    .string()
    .describe(
      "The next question. One question, short, about their real work. When the ground is " +
        "covered, say so and ask whether to move on.",
    ),
  candidates: z
    .array(
      z.object({
        type: z.enum(BLOCK_TYPES).describe("Which kind of passage this is."),
        text: z
          .string()
          .describe(
            "The passage as it would appear in the document. Self-contained — it will sit " +
              "beside blocks from other turns and cannot refer to the conversation.",
          ),
        /*
         * Only for an `example`, and only when the two halves genuinely separate. An eval case
         * needs the request in one field and what makes the answer right in the other; the
         * block text holds both together, which is right for a document and unusable as a
         * test. Stating them here costs nothing — the model has both in mind as it writes the
         * example — and omitting them is a real answer: an example that cannot be split was
         * not an input/output pair.
         */
        evalPrompt: z
          .string()
          .nullable()
          .describe(
            "For an `example` only: the request or input on its own, as somebody would " +
              "actually phrase it. Null for every other block type, and null when this " +
              "example does not separate into an input and an output.",
          ),
        evalExpectation: z
          .string()
          .nullable()
          .describe(
            "For an `example` only: what makes the right answer right, stated tightly enough " +
              "to check. Null otherwise.",
          ),
      }),
    )
    .max(MAX_CANDIDATES_PER_TURN)
    .describe(
      "Blocks supported by what they have just said. An empty list is correct when they " +
        "have not yet said anything concrete enough to write down.",
    ),
});

export type TurnResult = {
  question: string;
  candidates: Array<{ id: string; type: string; text: string }>;
  metered: MeteredResult;
};

export type TakeTurnInput = {
  sessionId: string;
  orgId: string;
  /** What the author just said. Empty on the opening turn, which the assistant leads. */
  authorText: string;
};

/**
 * Take one turn. Returns the partial stream for the UI and a promise for the stored result.
 *
 * The caller streams `partialStream` to the client and awaits `done` to persist — both come
 * from one call, so what is shown and what is stored cannot diverge.
 */
export async function takeTurn(input: TakeTurnInput): Promise<{
  partialStream: AsyncIterable<unknown>;
  done: Promise<TurnResult>;
}> {
  const loaded = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [session] = await tx
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, input.sessionId))
      .limit(1);
    if (!session) return null;

    const [draft] = await tx
      .select({
        name: skillDrafts.name,
        category: skillDrafts.archetypeCategory,
        purpose: skillDrafts.purpose,
        context: skillDrafts.context,
      })
      .from(skillDrafts)
      .where(eq(skillDrafts.id, session.draftId))
      .limit(1);
    if (!draft) return null;

    const turns = await tx
      .select({
        role: interviewTurns.role,
        text: interviewTurns.text,
        order: interviewTurns.turnOrder,
      })
      .from(interviewTurns)
      .where(eq(interviewTurns.sessionId, input.sessionId))
      .orderBy(asc(interviewTurns.turnOrder));

    /*
     * Accepted blocks only, so the assistant does not re-elicit what is already written.
     * Rejected candidates are deliberately not sent: the author said no, and putting them back
     * in front of the model is how a conversation starts arguing with somebody.
     */
    const written = await tx
      .select({ type: interviewCandidates.type, text: interviewCandidates.text })
      .from(interviewCandidates)
      .where(
        sql`${interviewCandidates.sessionId} = ${input.sessionId}
            and ${interviewCandidates.decision} in ('accepted', 'edited')`,
      );

    return { session, draft, turns, written };
  });

  if (!loaded) throw new Error("Interview session not found.");
  if (loaded.session.status !== "active") throw new Error("This interview has ended.");

  const modelTurns = loaded.turns.filter((turn) => turn.role === "assistant").length;
  const nextOrder = loaded.turns.length;

  /*
   * The author's words land first, and land whatever happens next.
   *
   * `applyAuthorTurn` is its own write rather than part of the transaction below, because the
   * model call sits between them and can take twenty seconds or refuse outright. Holding a
   * transaction open across it would pin a pool connection for the duration — the pool is
   * capped at ten — and would roll the author's answer back on a failure that had nothing to
   * do with it.
   */
  let authorTurnOrder = nextOrder;
  if (input.authorText.trim()) {
    await withExplicitOrgScope(input.orgId, async (tx) => {
      await tx.insert(interviewTurns).values({
        orgId: input.orgId,
        sessionId: input.sessionId,
        turnOrder: authorTurnOrder,
        role: "author",
        text: input.authorText.trim(),
      });
    });
  } else {
    authorTurnOrder = nextOrder - 1;
  }

  const messages = [
    {
      role: "user" as const,
      content: draftContext({
        name: loaded.draft.name,
        categoryLabel: labelFor("function", loaded.draft.category),
        purpose: loaded.draft.purpose,
        context: loaded.draft.context,
        existing: loaded.written,
      }),
    },
    ...loaded.turns.map((turn) => ({
      role: turn.role === "author" ? ("user" as const) : ("assistant" as const),
      content: turn.text,
    })),
    ...(input.authorText.trim()
      ? [{ role: "user" as const, content: input.authorText.trim() }]
      : []),
  ];

  const stream = await streamMeteredObject({
    task: "interview",
    purpose: "interview",
    orgId: input.orgId,
    conversationId: conversationIdFor(input.sessionId),
    turns: modelTurns,
    system: techniqueSystem(loaded.session.technique as InterviewTechnique),
    messages,
    schema: turnSchema,
    /*
     * Warmer than the classifier's zero and the same as the builder's, for the same reason:
     * a question generator at temperature zero asks the same question every time, and "ask me
     * something else" has to be able to do something.
     */
    temperature: 0.5,
  });

  const done = (async (): Promise<TurnResult> => {
    const output = await stream.output;
    const metered = await stream.metered;

    const assistantOrder = authorTurnOrder + 1;
    const stored = await withExplicitOrgScope(input.orgId, async (tx) => {
      const [turn] = await tx
        .insert(interviewTurns)
        .values({
          orgId: input.orgId,
          sessionId: input.sessionId,
          turnOrder: assistantOrder,
          role: "assistant",
          text: output.question,
        })
        .returning({ id: interviewTurns.id });

      const rows = output.candidates.slice(0, MAX_CANDIDATES_PER_TURN).filter(
        (candidate) => candidate.text.trim().length > 0,
      );
      const inserted =
        rows.length > 0
          ? await tx
              .insert(interviewCandidates)
              .values(
                rows.map((candidate) => ({
                  orgId: input.orgId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  type: candidate.type,
                  text: candidate.text.trim(),
                  /*
                   * Kept only where they mean something. A model that fills these in for a
                   * guardrail has misread the instruction, and storing that would make a
                   * guardrail eligible to become a golden task.
                   */
                  evalPrompt:
                    candidate.type === "example" ? (candidate.evalPrompt?.trim() || null) : null,
                  evalExpectation:
                    candidate.type === "example"
                      ? (candidate.evalExpectation?.trim() || null)
                      : null,
                })),
              )
              .returning({
                id: interviewCandidates.id,
                type: interviewCandidates.type,
                text: interviewCandidates.text,
              })
          : [];

      await tx
        .update(interviewSessions)
        .set({ updatedAt: new Date() })
        .where(eq(interviewSessions.id, input.sessionId));

      return inserted;
    });

    return { question: output.question, candidates: stored, metered };
  })();

  /*
   * A turn whose persistence fails must not become an unhandled rejection. The caller awaits
   * `done`; this only makes the abandoned case safe, the same guard the metering promise has.
   */
  void done.catch(() => undefined);

  return { partialStream: stream.partialStream, done };
}

/**
 * End the session when the budget or the turn cap is what stopped it.
 *
 * Recorded rather than left implicit, because "the author walked away" and "this hit its cap"
 * look identical from a row that only says `ended`, and only one of them is a thing anybody
 * should act on.
 */
export async function endForBudget(
  sessionId: string,
  orgId: string,
  block: string,
): Promise<void> {
  await endSession(sessionId, orgId, `budget:${block}`);
}
