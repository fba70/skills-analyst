import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  isEvalKind,
  isEvalSource,
  isEvalVerdict,
  MAX_EXPECTATION_CHARS,
  MAX_PROMPT_CHARS,
  summarise,
  type EvalCaseState,
  type EvalKind,
  type EvalSource,
  type EvalSummary,
} from "@/lib/evals";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { evalRuns, skillEvals } from "@/server/db/schema";

/**
 * Eval cases and their history (Doc 2 R2.11, Doc 6 RW.6, plan step D1).
 *
 * The runner is `run.ts`; this is the state around it. Split for the reason `session.ts` and
 * `turn.ts` are: everything here is ordinary org-scoped persistence that needs no model, which
 * is what lets `verify:evals` exercise the publish gate, the staleness rule and the regression
 * rule for free.
 */

/** The document a run is judged against. One definition, used by the runner and the gate. */
export function contentHashOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export type EvalParent = { draftId: string } | { skillId: string };

/**
 * Which parent a draft's eval cases hang off right now.
 *
 * `publishDraft` re-points every case from the draft to the skill it became, so after
 * publication `{ draftId }` finds nothing — the eval panel would empty, the trigger lab would
 * report unknown, and the matrix would find zero tasks. All three look like data loss and none
 * of them is.
 *
 * One helper rather than the same ternary at four call sites, because the fourth is the one it
 * would be forgotten at. It lives here rather than beside the actions because a `"use server"`
 * module may only export server actions, and this is a two-line pure function.
 */
export function evalParentFor(draft: {
  id: string;
  publishedSkillId: string | null;
}): EvalParent {
  return draft.publishedSkillId ? { skillId: draft.publishedSkillId } : { draftId: draft.id };
}

export type CreateEvalInput = EvalParent & {
  orgId: string;
  userId: string | null;
  kind: EvalKind;
  prompt: string;
  expectation?: string | null;
  source?: EvalSource;
  sourceCandidateId?: string | null;
  /** The rule row's content key, for a case proposed by RD.4. */
  sourceRule?: string | null;
};

export async function createEval(
  input: CreateEvalInput,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (!isEvalKind(input.kind)) return { ok: false, message: "Unknown case kind." };
  const prompt = input.prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return { ok: false, message: "A case needs a request to test." };

  /*
   * A golden task without an expectation is unjudgeable, and it would fail every run for a
   * reason that is our fault rather than the skill's. Refused at the boundary rather than
   * discovered by the judge, because the author is the only one who can supply it.
   */
  const expectation = (input.expectation ?? "").trim().slice(0, MAX_EXPECTATION_CHARS);
  if (input.kind === "golden-task" && !expectation) {
    return { ok: false, message: "A golden task needs to say what makes the answer right." };
  }

  const id = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(skillEvals)
      .values({
        orgId: input.orgId,
        draftId: "draftId" in input ? input.draftId : null,
        skillId: "skillId" in input ? input.skillId : null,
        kind: input.kind,
        prompt,
        expectation: input.kind === "golden-task" ? expectation : null,
        source: input.source ?? "authored",
        sourceCandidateId: input.sourceCandidateId ?? null,
        sourceRule: input.sourceRule ?? null,
        createdBy: input.userId,
      })
      .returning({ id: skillEvals.id });
    return row.id;
  });

  return { ok: true, id };
}

export async function deleteEval(id: string, orgId: string): Promise<void> {
  await withExplicitOrgScope(orgId, async (tx) => {
    await tx.delete(skillEvals).where(eq(skillEvals.id, id));
  });
}

/**
 * Every case for one parent, each carrying its newest run and the newest run before it.
 *
 * Two runs, not one, and that is the whole of the regression rule: "is this failing" needs the
 * latest, and "did it used to pass" needs the one before. Fetching only the latest would make
 * the publish gate choose between blocking on any failure — which stops an author publishing a
 * skill whose aspirational case has never passed — and blocking on nothing.
 *
 * `previous` is the newest run against a **different** document, not simply the second-newest.
 * Re-running the same document twice must not make a case look like it changed.
 */
export async function evalStates(
  parent: EvalParent,
  orgId: string,
): Promise<EvalCaseState[]> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const cases = await tx
      .select()
      .from(skillEvals)
      .where(
        "draftId" in parent
          ? eq(skillEvals.draftId, parent.draftId)
          : eq(skillEvals.skillId, parent.skillId),
      )
      .orderBy(asc(skillEvals.createdAt));

    if (cases.length === 0) return [];

    const runs = await tx
      .select({
        evalId: evalRuns.evalId,
        verdict: evalRuns.verdict,
        detail: evalRuns.detail,
        contentHash: evalRuns.contentHash,
        runAt: evalRuns.runAt,
      })
      .from(evalRuns)
      /*
       * `inArray`, not a hand-built `in (...)`. These ids come from our own table and would be
       * safe interpolated, which is exactly the reasoning that puts an injection in a codebase
       * eventually — the parameterised form costs nothing and does not depend on where the
       * values came from staying true.
       */
      /*
       * Skill CI runs only. A matrix arm (`with_skill` non-null) is a measurement of what
       * happens *without* the skill as often as with it, and letting one into this stream would
       * make the newest run per case sometimes describe a document the author never wrote — a
       * without-arm failure reading as a regression and blocking the publish.
       */
      .where(
        and(
          inArray(
            evalRuns.evalId,
            cases.map((c) => c.id),
          ),
          isNull(evalRuns.withSkill),
        ),
      )
      .orderBy(desc(evalRuns.runAt));

    const byCase = new Map<string, typeof runs>();
    for (const run of runs) {
      const list = byCase.get(run.evalId) ?? [];
      list.push(run);
      byCase.set(run.evalId, list);
    }

    return cases.map((row) => {
      const history = byCase.get(row.id) ?? [];
      const latest = history[0] ?? null;
      const previous = latest
        ? (history.find((run) => run.contentHash !== latest.contentHash) ?? null)
        : null;
      return {
        id: row.id,
        kind: (isEvalKind(row.kind) ? row.kind : "should-trigger") as EvalKind,
        prompt: row.prompt,
        expectation: row.expectation,
        /*
         * Asked of the vocabulary, not matched against one value of it.
         *
         * This read was `row.source === "interview" ? "interview" : "authored"`, which is correct
         * for exactly as long as there are two sources — and RD.4 adds a third, so every case
         * proposed from a rule would have come back labelled as one the author typed. A ternary
         * that collapses an open vocabulary to its two known members is the shape that inferred
         * resolution from an answer looking different in `verify:embeddings`: it cannot report
         * the case it does not know about, and it reports a confident wrong value instead.
         */
        source: isEvalSource(row.source) ? row.source : "authored",
        sourceRule: row.sourceRule,
        latest: latest
          ? {
              verdict: isEvalVerdict(latest.verdict) ? latest.verdict : "error",
              detail: latest.detail,
              contentHash: latest.contentHash,
            }
          : null,
        previous: previous
          ? {
              verdict: isEvalVerdict(previous.verdict) ? previous.verdict : "error",
              contentHash: previous.contentHash,
            }
          : null,
      };
    });
  });
}

export async function evalSummary(
  parent: EvalParent,
  orgId: string,
  contentHash: string,
): Promise<EvalSummary> {
  return summarise(await evalStates(parent, orgId), contentHash);
}

/**
 * Move a draft's cases onto the skill it became (R6.1).
 *
 * Called inside `publishDraft`'s transaction. Re-pointed rather than copied: a copy would mean
 * two rows claiming the same case, and the run history — which is the only thing that makes a
 * regression detectable — would stay behind on the draft while the skill started from nothing.
 *
 * The check constraint is what makes this safe to get wrong: setting `skill_id` without
 * clearing `draft_id` is refused by the database rather than producing a case that appears in
 * two places.
 */
export async function repointToSkill(
  draftId: string,
  skillId: string,
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
): Promise<void> {
  await tx.execute(
    sql`update skill_evals set skill_id = ${skillId}, draft_id = null, updated_at = now()
        where draft_id = ${draftId}`,
  );
}
