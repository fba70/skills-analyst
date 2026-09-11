import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import { isBlockType, type BlockType } from "@/lib/block-types";
import type { ConversationBudget } from "@/lib/conversation";
import {
  isCandidateDecision,
  isInterviewTechnique,
  type CandidateDecision,
  type InterviewRole,
  type InterviewTechnique,
} from "@/lib/interview";
import { conversationBudget } from "@/server/billing/conversation";
import { withExplicitOrgScope } from "@/server/dal/scope";
import {
  events,
  interviewCandidates,
  interviewSessions,
  interviewTurns,
  skillDrafts,
} from "@/server/db/schema";

/**
 * Interview sessions: starting one, reading one, ending one (Doc 6 RW.4, plan step C2b).
 *
 * The turn itself — the model call — is `turn.ts`. This module is the state around it, and
 * keeping them apart matters for one reason: everything here is ordinary org-scoped
 * persistence that can be exercised with no model at all, which is what lets `verify:interview`
 * check the accept flow, the decision record and the draft write for free.
 */

export type InterviewCandidateRow = {
  id: string;
  type: BlockType;
  text: string;
  decision: CandidateDecision;
  editedText: string | null;
  draftBlockId: string | null;
};

export type InterviewTurnRow = {
  id: string;
  order: number;
  role: InterviewRole;
  text: string;
  candidates: InterviewCandidateRow[];
};

export type InterviewSessionDetail = {
  id: string;
  draftId: string;
  technique: InterviewTechnique;
  status: string;
  endedReason: string | null;
  turns: InterviewTurnRow[];
  /**
   * Turns the *model* has taken, which is what the budget counts.
   *
   * Not `turns.length`: the transcript holds an author row and an assistant row per exchange,
   * so counting rows would halve the effective cap and nobody would understand why the
   * conversation stopped at fifteen. The number that costs money is the number of calls.
   */
  modelTurns: number;
  budget: ConversationBudget;
};

/** The id a conversation's ledger rows are summed under. The session id, and nothing else. */
export const conversationIdFor = (sessionId: string) => sessionId;

export async function startSession(input: {
  draftId: string;
  orgId: string;
  userId: string | null;
  technique: InterviewTechnique;
}): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  if (!isInterviewTechnique(input.technique)) {
    return { ok: false, message: "Unknown interview technique." };
  }

  /*
   * Refused on the button rather than on the first turn.
   *
   * A session started with a hundredth of a cent of room greets the author and immediately
   * refuses — and delivering that greeting costs a call. Better to decline before there is a
   * transcript to abandon.
   */
  const { canStartConversation } = await import("@/server/billing/conversation");
  const allowed = await canStartConversation(input.orgId);
  if (!allowed.ok) return { ok: false, message: allowed.message };

  return withExplicitOrgScope(input.orgId, async (tx) => {
    const [draft] = await tx
      .select({ id: skillDrafts.id })
      .from(skillDrafts)
      .where(eq(skillDrafts.id, input.draftId))
      .limit(1);
    if (!draft) return { ok: false as const, message: "Draft not found." };

    const [row] = await tx
      .insert(interviewSessions)
      .values({
        orgId: input.orgId,
        draftId: input.draftId,
        technique: input.technique,
        createdBy: input.userId,
      })
      .returning({ id: interviewSessions.id });

    /*
     * Inside the transaction, like publish-back's audit row. Written after it, with a plain
     * handle, it would be refused by RLS and swallowed — which is exactly how `publishDraft`
     * shipped a skill with no record of who published it.
     */
    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId ?? "unknown",
      kind: "interview.started",
      subjectType: "interview_sessions",
      subjectId: row.id,
      reason: input.technique,
      payload: { draftId: input.draftId, technique: input.technique },
    });

    return { ok: true as const, sessionId: row.id };
  });
}

export async function getSession(
  sessionId: string,
  orgId: string,
): Promise<InterviewSessionDetail | null> {
  const loaded = await withExplicitOrgScope(orgId, async (tx) => {
    const [session] = await tx
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, sessionId))
      .limit(1);
    if (!session) return null;

    const turns = await tx
      .select()
      .from(interviewTurns)
      .where(eq(interviewTurns.sessionId, sessionId))
      .orderBy(asc(interviewTurns.turnOrder));

    const candidates = await tx
      .select()
      .from(interviewCandidates)
      .where(eq(interviewCandidates.sessionId, sessionId))
      .orderBy(asc(interviewCandidates.createdAt));

    return { session, turns, candidates };
  });
  if (!loaded) return null;

  const byTurn = new Map<string, InterviewCandidateRow[]>();
  for (const row of loaded.candidates) {
    if (!isBlockType(row.type)) continue;
    /*
     * `turn_id` is nullable since C4, because a distill candidate has no turn. This query is
     * scoped to one interview session, so every row here has one — skipping rather than asserting
     * keeps the grouping honest if that ever stops being true.
     */
    if (row.turnId === null) continue;
    const list = byTurn.get(row.turnId) ?? [];
    list.push({
      id: row.id,
      type: row.type,
      text: row.text,
      decision: isCandidateDecision(row.decision) ? row.decision : "pending",
      editedText: row.editedText,
      draftBlockId: row.draftBlockId,
    });
    byTurn.set(row.turnId, list);
  }

  const turns: InterviewTurnRow[] = loaded.turns.map((row) => ({
    id: row.id,
    order: row.turnOrder,
    role: row.role === "author" ? "author" : "assistant",
    text: row.text,
    candidates: byTurn.get(row.id) ?? [],
  }));

  const modelTurns = turns.filter((turn) => turn.role === "assistant").length;

  return {
    id: loaded.session.id,
    draftId: loaded.session.draftId,
    technique: loaded.session.technique as InterviewTechnique,
    status: loaded.session.status,
    endedReason: loaded.session.endedReason,
    turns,
    modelTurns,
    budget: await conversationBudget({
      conversationId: conversationIdFor(sessionId),
      orgId,
      turns: modelTurns,
    }),
  };
}

/** Sessions on one draft, newest first. */
export async function listSessions(draftId: string, orgId: string) {
  return withExplicitOrgScope(orgId, async (tx) =>
    tx
      .select({
        id: interviewSessions.id,
        technique: interviewSessions.technique,
        status: interviewSessions.status,
        createdAt: interviewSessions.createdAt,
        /*
         * Prefixes spelled out, never interpolated. Drizzle drops qualification on a
         * single-table select, so `${interviewSessions.id}` renders a bare `"id"` — which
         * Postgres resolves to the *inner* table, making this `t.session_id = t.id` and the
         * count silently zero. Not an error: measured at 0 against a correct 1 on a populated
         * pair. `latestSignal` in `dal/skills.ts` warns about exactly this.
         */
        turns: sql<number>`(
          select count(*)::int from interview_turns t
          where t.session_id = "interview_sessions"."id" and t.role = 'assistant'
        )`,
        accepted: sql<number>`(
          select count(*)::int from interview_candidates c
          where c.session_id = "interview_sessions"."id" and c.decision in ('accepted', 'edited')
        )`,
      })
      .from(interviewSessions)
      .where(eq(interviewSessions.draftId, draftId))
      .orderBy(desc(interviewSessions.createdAt))
      .limit(20),
  );
}

export async function endSession(
  sessionId: string,
  orgId: string,
  reason: string,
): Promise<void> {
  await withExplicitOrgScope(orgId, async (tx) => {
    await tx
      .update(interviewSessions)
      .set({ status: "ended", endedReason: reason, updatedAt: new Date() })
      .where(
        and(eq(interviewSessions.id, sessionId), eq(interviewSessions.status, "active")),
      );
  });
}
