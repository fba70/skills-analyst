import "server-only";

import { eq, sql } from "drizzle-orm";

import { isBlockType } from "@/lib/block-types";
import type { CandidateDecision } from "@/lib/interview";
import { withExplicitOrgScope } from "@/server/dal/scope";
import {
  events,
  interviewCandidates,
  interviewSessions,
} from "@/server/db/schema";
import { getDraftBlocks, setDraftBlocks } from "@/server/builder/blocks";

/**
 * Accepting or rejecting one suggested block (Doc 2 R5.1 and R5.4, plan step C2b).
 *
 * ## The two requirements are one motion, and that is the design
 *
 * R5.1 asks the assistant to elicit requirements; R5.4 asks for feedback on each suggestion.
 * Built separately they are a chat window plus a thumbs-up control, and the thumbs-up control
 * is the one everybody ignores — a rating asked for its own sake gets answered carelessly or
 * not at all.
 *
 * Here the feedback **is** the action the author already wanted to take. Accepting puts the
 * block on the draft; rejecting does not. Neither costs an extra click, and both produce a row
 * that says which technique and which block type it came from. That is R5.4 satisfied by a
 * control nobody can ignore, because ignoring it means not getting the block.
 *
 * ## Accepting writes through the one writer
 *
 * A candidate becomes a draft block through `setDraftBlocks`, exactly as every other change to
 * a draft does. Nothing here touches `skill_drafts.body` — the body is a render, and a second
 * writer is the failure `verify:draft-blocks` asserts against the source tree.
 *
 * It also means an accept lands in the revision history with its own reason, so an author
 * scanning `/build/[id]` can see which blocks came out of a conversation.
 */

export type DecideResult =
  | { ok: true; decision: CandidateDecision; draftBlockId: string | null }
  | { ok: false; message: string };

export async function decideCandidate(input: {
  candidateId: string;
  orgId: string;
  userId: string | null;
  decision: Exclude<CandidateDecision, "pending">;
  /** The author's version. Present only when they changed it before accepting. */
  editedText?: string | null;
}): Promise<DecideResult> {
  const loaded = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: interviewCandidates.id,
        sessionId: interviewCandidates.sessionId,
        type: interviewCandidates.type,
        text: interviewCandidates.text,
        decision: interviewCandidates.decision,
        draftId: interviewSessions.draftId,
        technique: interviewSessions.technique,
      })
      .from(interviewCandidates)
      .innerJoin(interviewSessions, eq(interviewSessions.id, interviewCandidates.sessionId))
      .where(eq(interviewCandidates.id, input.candidateId))
      .limit(1);
    return row ?? null;
  });

  if (!loaded) return { ok: false, message: "Suggestion not found." };
  /*
   * Decided once. A second decision would double-count in every accept-rate query and, on an
   * accept, would append the same block twice — the same "recorded then applied again" shape
   * the outcome dedup index exists to make impossible.
   */
  if (loaded.decision !== "pending") {
    return { ok: false, message: "That suggestion has already been decided." };
  }
  if (!isBlockType(loaded.type)) return { ok: false, message: "Unknown block type." };

  const keeping = input.decision === "accepted" || input.decision === "edited";
  const text = (keeping ? (input.editedText ?? loaded.text) : loaded.text).trim();
  if (keeping && !text) return { ok: false, message: "There is nothing to add." };

  let draftBlockId: string | null = null;

  if (keeping) {
    /*
     * Appended at the end, not inserted at a guessed position.
     *
     * The archetype's block grammar carries a typical position, and it is a *median over a
     * corpus* rather than a statement about this document — dropping a guardrail into the
     * middle of somebody's procedure because the corpus usually puts it there would be the
     * builder acting on evidence it does not have. C1b's reorder is one drag away, and the
     * author knows where it goes.
     */
    const existing = await getDraftBlocks(loaded.draftId, input.orgId);
    const result = await setDraftBlocks(
      loaded.draftId,
      input.orgId,
      [
        ...existing.map((block) => ({
          id: block.id,
          form: block.form,
          depth: block.depth,
          type: block.type,
          text: block.text,
        })),
        { form: "content" as const, depth: null, type: loaded.type, text },
      ],
      {
        reason: "interview",
        note: `${loaded.technique} · ${loaded.type}`,
        createdBy: input.userId,
      },
    );
    draftBlockId = result.blocks[result.blocks.length - 1]?.id ?? null;
  }

  await withExplicitOrgScope(input.orgId, async (tx) => {
    await tx
      .update(interviewCandidates)
      .set({
        decision: input.decision,
        editedText: input.decision === "edited" ? text : null,
        decidedAt: new Date(),
        draftBlockId,
      })
      .where(eq(interviewCandidates.id, input.candidateId));

    /**
     * The structured feedback event R6.2 can consume.
     *
     * Written now, consumed by nothing yet, and that is stated rather than implied. Creation
     * telemetry earned its influence over `mineArchetype` by accumulating enough signal to
     * survive R6.5's trimming; this has none. Wiring a near-empty input into the thing that
     * scaffolds every future draft is how a loop poisons itself with its own noise — the same
     * line R6.3's outcome signals hold.
     *
     * What the row does carry is everything a later consumer needs: the technique, the block
     * type, and whether it was kept as written or fixed first.
     */
    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId ?? "unknown",
      kind: `interview.${input.decision}`,
      subjectType: "interview_candidates",
      subjectId: input.candidateId,
      reason: `${loaded.technique} · ${loaded.type}`,
      payload: {
        technique: loaded.technique,
        blockType: loaded.type,
        draftId: loaded.draftId,
        /*
         * How far a kept suggestion had to move. A better measure of whether the assistant is
         * helping than a bare accept count, and free to record because both versions are on
         * the row.
         */
        editedChars: input.decision === "edited" ? Math.abs(text.length - loaded.text.length) : 0,
      },
    });
  });

  return { ok: true, decision: input.decision, draftBlockId };
}

/**
 * Accept rate per technique and block type — the number that decides what gets pruned.
 *
 * Doc 6 §7 names over-structuring as this programme's risk and expects some of the block
 * taxonomy to be pruned on evidence. The same applies to the five techniques: one whose
 * candidates are always rejected is one to drop, and the only way to know is to have kept the
 * rejections. Which is why `decideCandidate` never deletes a row.
 *
 * Org-scoped, deliberately. Cross-organisation aggregation is what `builder_signals` is for,
 * and it is safe there **because of its column list** — booleans and closed vocabularies, no
 * tenant content. A candidate carries the author's own prose, so this stays inside the tenant
 * and the cross-org version, if it is ever wanted, is a separate table with a narrower shape.
 */
export type CandidateStat = {
  technique: string;
  type: string;
  proposed: number;
  kept: number;
  edited: number;
  rejected: number;
  pending: number;
};

export async function candidateStats(orgId: string): Promise<CandidateStat[]> {
  return withExplicitOrgScope(orgId, async (tx) =>
    tx
      .select({
        technique: interviewSessions.technique,
        type: interviewCandidates.type,
        proposed: sql<number>`count(*)::int`,
        kept: sql<number>`count(*) filter (where ${interviewCandidates.decision} in ('accepted', 'edited'))::int`,
        edited: sql<number>`count(*) filter (where ${interviewCandidates.decision} = 'edited')::int`,
        rejected: sql<number>`count(*) filter (where ${interviewCandidates.decision} = 'rejected')::int`,
        pending: sql<number>`count(*) filter (where ${interviewCandidates.decision} = 'pending')::int`,
      })
      .from(interviewCandidates)
      .innerJoin(interviewSessions, eq(interviewSessions.id, interviewCandidates.sessionId))
      .groupBy(interviewSessions.technique, interviewCandidates.type)
      .orderBy(sql`count(*) desc`),
  );
}
