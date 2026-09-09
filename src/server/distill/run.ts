import "server-only";

import { asc, desc, eq, inArray } from "drizzle-orm";

import { generateText, Output } from "ai";
import { z } from "zod";

import { BLOCK_TYPES, isBlockType } from "@/lib/block-types";
import {
  correctionWindows,
  DISTILL_VERSION,
  MAX_WINDOWS_PER_RUN,
  parseTranscript,
  redact,
  type CorrectionWindow,
} from "@/lib/distill";
import { assertWithinBudget, recordUsage } from "@/server/billing/spend";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { distillRuns, events, interviewCandidates } from "@/server/db/schema";


/**
 * Distill mode, the metered half (Doc 6 RW.5, plan step C4).
 *
 * The parser in `src/lib/distill.ts` decides what a person actually said and which of it looks
 * like a correction. This spends money on the result.
 *
 * ## Nothing here re-implements the accept flow
 *
 * Candidates land in `interview_candidates` with a `distill_run_id` instead of a session, and
 * `decideCandidate` resolves the draft from whichever origin matched. That was the whole reason
 * for widening one table rather than adding a second: two candidate tables would be two accept
 * paths, and the second would eventually forget the revision-history note, the eval case, or
 * R5.4's feedback event.
 *
 * ## Patterns, not verbatim text — enforced in the prompt and in the schema
 *
 * Doc 6 asks for *patterns, not verbatim text*, and the reason is that a transcript is somebody's
 * working day. So the model is asked for a **rule**, in the author's voice, that would have
 * prevented the correction — not a quotation of it. The output schema has no field a transcript
 * excerpt could be returned in, which is the half of that instruction a prompt cannot enforce on
 * its own.
 *
 * ## Private by construction (RC.5)
 *
 * Org-scoped throughout, and it never feeds a public archetype — creation telemetry is the only
 * thing that reaches `mineArchetype`, and it carries structure rather than content. The stronger
 * property is upstream: the transcript is never stored, so there is nothing here for a later
 * aggregate to reach even if somebody wired one.
 */

/** One correction becomes at most this many blocks. A rule, not an essay. */
const MAX_BLOCKS_PER_WINDOW = 2;

const CandidateSchema = z.object({
  blocks: z
    .array(
      z.object({
        type: z.enum(BLOCK_TYPES),
        /** The rule as the author would state it. Never a quotation of the transcript. */
        text: z.string().min(12).max(600),
        /** Why this is a durable rule rather than a one-off. One line, shown to the author. */
        why: z.string().max(200),
      }),
    )
    .max(MAX_BLOCKS_PER_WINDOW),
});

const SYSTEM = `You read one short excerpt from a working session between an engineer and a coding agent, in which the engineer corrected the agent.

Your job is to state the DURABLE RULE behind the correction, in the engineer's own voice, as if it were being written into a skill document for future agents.

Rules:
- Write the rule, never a quotation or a summary of the conversation. "Always run the dry run first" — not "the user asked for a dry run".
- Only extract a rule that would apply again. A correction about one filename, one typo or one number is not a rule; return no blocks.
- Prefer guardrail for an unconditional prohibition or requirement, decision-rule for a choice with a condition, procedure for an ordered sequence, tool-contract for how a specific tool must be invoked.
- Never include file contents, paths, credentials, names or anything that identifies a person or a system. If the correction cannot be stated without them, return no blocks.
- Return at most two blocks. Most excerpts yield one, and many yield none. Returning none is a correct and common answer.`;

export type DistillInput = {
  orgId: string;
  userId: string;
  draftId: string;
  /** The raw JSONL. Read, used and dropped — never written anywhere. */
  transcript: string;
  /** The author's own label. Never the file's path, which is itself revealing. */
  label?: string | null;
};

export type DistillReport = {
  runId: string;
  turnsRead: number;
  humanTurns: number;
  toolResultsDropped: number;
  windowsFound: number;
  windowsSent: number;
  redactions: number;
  candidates: number;
  costMicros: number;
};

export type DistillResult =
  | { ok: true; report: DistillReport }
  | { ok: false; message: string };

export async function distillTranscript(input: DistillInput): Promise<DistillResult> {
  const parsed = parseTranscript(input.transcript);
  if (parsed.turns.length === 0) {
    return { ok: false, message: "No conversation in that file — every row was tool output or housekeeping." };
  }

  const windows = correctionWindows(parsed.turns);
  if (windows.length === 0) {
    /*
     * A real answer, not a failure.
     *
     * A session where nobody corrected the agent contains no captured judgement, and saying so
     * is more useful than an empty candidate list the author would read as the feature being
     * broken. Same distinction the endorsement card draws between "nobody was eligible" and
     * "nobody did".
     */
    return {
      ok: false,
      message: `Read ${parsed.turns.length} turns and found no corrections. Nothing was distilled, which usually means the session went to plan.`,
    };
  }

  const sending = windows.slice(0, MAX_WINDOWS_PER_RUN);
  /* Resolved once for the whole run, so every call, budget check and ledger row names one id. */
  const { modelFor } = await import("@/server/settings/models");
  const model = await modelFor("distill");

  /*
   * Budget checked once, before the first call, against the *whole* run.
   *
   * RC.2's before-check/after-ledger order bounds an overshoot at one call, and a run of forty
   * calls would blow through that forty times over if each checked for itself. So the check is up
   * front and the loop stops the moment a later check refuses — an author gets the candidates
   * already produced rather than a refusal that discards them.
   */
  await assertWithinBudget("builder", input.orgId);

  const runId = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(distillRuns)
      .values({
        orgId: input.orgId,
        draftId: input.draftId,
        createdBy: input.userId,
        label: input.label?.trim().slice(0, 120) || null,
        distillVersion: DISTILL_VERSION,
        model,
        turnsRead: parsed.turns.length,
        humanTurns: parsed.turns.filter((turn) => turn.role === "human").length,
        toolResultsDropped: parsed.toolResults,
        windowsFound: windows.length,
        windowsSent: sending.length,
      })
      .returning({ id: distillRuns.id });
    return row.id;
  });

  let costMicros = 0;
  let redactions = 0;
  let candidates = 0;
  let sent = 0;

  for (const window of sending) {
    const { text: excerpt, hits } = redactWindow(window);
    redactions += hits;

    try {
      await assertWithinBudget("builder", input.orgId);
    } catch {
      /* Out of budget mid-run: keep what was produced and stop. The report says how far it got. */
      break;
    }

    let blocks: Array<{ type: string; text: string; why: string }> = [];
    try {
      const { output, usage } = await generateText({
        model,
        temperature: 0.2,
        system: SYSTEM,
        prompt: excerpt,
        output: Output.object({ schema: CandidateSchema }),
      });
      blocks = output?.blocks ?? [];
      costMicros += await recordUsage({
        purpose: "builder",
        orgId: input.orgId,
        model,
        usage,
        subjectType: "distill_runs",
        subjectId: runId,
      });
    } catch {
      /*
       * One refused or failed window must not cost the run.
       *
       * `mapSettled`'s lesson, applied by hand because this loop is sequential for budget
       * reasons: a transcript with one excerpt the model declines still has thirty-nine others
       * worth reading, and losing them would make the feature look broken by its own safety.
       */
      continue;
    }
    sent += 1;

    const usable = blocks.filter((block) => isBlockType(block.type) && block.text.trim().length > 0);
    if (usable.length === 0) continue;

    await withExplicitOrgScope(input.orgId, async (tx) => {
      await tx.insert(interviewCandidates).values(
        usable.map((block) => ({
          orgId: input.orgId,
          /* No session and no turn: the check constraint requires exactly one origin. */
          sessionId: null,
          turnId: null,
          distillRunId: runId,
          type: block.type,
          text: block.text.trim(),
        })),
      );
    });
    candidates += usable.length;
  }

  await withExplicitOrgScope(input.orgId, async (tx) => {
    /*
     * The row claimed `sending.length` before the loop ran. Corrected to what was actually sent,
     * because a run that stopped on budget would otherwise report forty calls it never made —
     * and `windows_sent` is one of the numbers an operator would use to explain a bill.
     */
    await tx
      .update(distillRuns)
      .set({ windowsSent: sent, redactions })
      .where(eq(distillRuns.id, runId));

    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "distill.run",
      subjectType: "distill_runs",
      subjectId: runId,
      /*
       * Counts only. There is no field here a transcript excerpt could travel in, which is the
       * same safe-because-of-the-column-list argument `builder_signals` makes for its open read
       * policy — except this row is org-scoped as well.
       */
      payload: {
        distillVersion: DISTILL_VERSION,
        turnsRead: parsed.turns.length,
        toolResultsDropped: parsed.toolResults,
        windowsFound: windows.length,
        windowsSent: sent,
        candidates,
      },
    });
  });

  return {
    ok: true,
    report: {
      runId,
      turnsRead: parsed.turns.length,
      humanTurns: parsed.turns.filter((turn) => turn.role === "human").length,
      toolResultsDropped: parsed.toolResults,
      windowsFound: windows.length,
      windowsSent: sent,
      redactions,
      candidates,
      costMicros,
    },
  };
}

/**
 * One window, redacted and rendered for the prompt.
 *
 * Roles are labelled rather than left implicit, because the whole extraction turns on which
 * speaker is the authority — the engineer's correction is the knowledge and the agent's reply is
 * context. Redaction runs per turn, after parsing has already removed the tool output where most
 * secrets in a coding transcript live.
 */
function redactWindow(window: CorrectionWindow): { text: string; hits: number } {
  let hits = 0;
  const lines = window.turns.map((turn) => {
    const { text, hits: n } = redact(turn.text);
    hits += n;
    return `${turn.role === "human" ? "ENGINEER" : "AGENT"}: ${text}`;
  });
  return { text: lines.join("\n\n"), hits };
}

/**
 * A draft's distill runs and their pending candidates.
 *
 * Candidates come back grouped by run rather than as a flat list, because *"eight corrections
 * from Tuesday's session"* and *"three from last week's"* are different provenance and the author
 * decides differently knowing which. It is also the only place the counts on the run row are
 * read, and they are what makes a run legible without its input.
 */
export async function listDistillRuns(draftId: string, orgId: string) {
  return withExplicitOrgScope(orgId, async (tx) => {
    const runs = await tx
      .select({
        id: distillRuns.id,
        label: distillRuns.label,
        createdAt: distillRuns.createdAt,
        turnsRead: distillRuns.turnsRead,
        humanTurns: distillRuns.humanTurns,
        toolResultsDropped: distillRuns.toolResultsDropped,
        windowsFound: distillRuns.windowsFound,
        windowsSent: distillRuns.windowsSent,
        redactions: distillRuns.redactions,
      })
      .from(distillRuns)
      .where(eq(distillRuns.draftId, draftId))
      .orderBy(desc(distillRuns.createdAt))
      .limit(20);

    if (runs.length === 0) return [];

    const rows = await tx
      .select({
        id: interviewCandidates.id,
        runId: interviewCandidates.distillRunId,
        type: interviewCandidates.type,
        text: interviewCandidates.text,
        decision: interviewCandidates.decision,
      })
      .from(interviewCandidates)
      .where(
        inArray(
          interviewCandidates.distillRunId,
          runs.map((run) => run.id),
        ),
      )
      .orderBy(asc(interviewCandidates.createdAt));

    return runs.map((run) => ({
      ...run,
      candidates: rows.filter((row) => row.runId === run.id),
    }));
  });
}
