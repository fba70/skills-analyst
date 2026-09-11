import "server-only";

import { ruleState } from "@/lib/parameters";
import {
  MAX_RULE_CASE_PROPOSALS,
  RULE_CASE_KIND,
  ruleCaseReport,
  type RuleCaseProposal,
  type RuleCaseReport,
} from "@/lib/rule-cases";
import { getDraftBlocks } from "@/server/builder/blocks";
import { createEval, evalParentFor, evalStates, type EvalParent } from "@/server/evals/store";

/**
 * Rule rows offered as eval cases (Doc 7 RD.4, plan step P6).
 *
 * Two functions and no model. `proposalsFor` renders the offers, `acceptRuleCases` writes the
 * ones an author picked through the same `createEval` every other case goes through — so a case
 * from a rule is an ordinary case the moment it exists, and the run path, the publish gate, the
 * trigger lab and D3's with/without matrix all pick it up with no special case anywhere.
 *
 * **Nothing here gates anything.** `publishDraft` never reads this module; an author may ship a
 * skill whose every rule is untested, exactly as they may ship one with uncovered cases. R4.5
 * stays the only gate and a regression stays the only eval-shaped block.
 * `verify:rule-cases` asserts both against the source rather than against today's data.
 */

export type DraftRef = { id: string; publishedSkillId: string | null };

/**
 * What the draft's structured rules would test, minus what they already test.
 *
 * The blocks are filtered to **in-step** here rather than inside the leaf, for the same reason
 * `coverageFor` does it: `ruleState` is the one definition of whether a structure still describes
 * its own sentence, and a second reading of that would eventually disagree with the mark the
 * author is looking at on screen.
 */
export async function proposalsFor(
  draft: DraftRef,
  orgId: string,
): Promise<RuleCaseReport> {
  const parent: EvalParent = evalParentFor(draft);
  const [blocks, cases] = await Promise.all([
    getDraftBlocks(draft.id, orgId),
    evalStates(parent, orgId),
  ]);

  const structured = blocks
    .filter((b) => b.form === "content" && b.type === "decision-rule")
    .filter((b) => b.rule && ruleState(b) === "in-step")
    .map((b) => ({ id: b.id, rows: b.rule?.rows ?? [] }));

  /*
   * Every key any existing case carries, whatever its source. A case written by hand that happens
   * to carry a key cannot exist — only this path sets one — but reading the whole set rather than
   * filtering on `source = 'rule'` means a case whose source was later corrected still suppresses
   * its proposal, and the alternative would re-offer a case the author plainly has.
   */
  const taken = new Set(cases.map((c) => c.sourceRule).filter((k): k is string => Boolean(k)));

  return ruleCaseReport(structured, taken);
}

export type AcceptResult = {
  created: number;
  /** Keys that no longer name a proposable row — the rule moved while the page was open. */
  missed: number;
  ids: string[];
};

/**
 * Accept one or more offers.
 *
 * **The prompt and the expectation are never taken from the caller.** They are re-derived here
 * from the row the key names, so a client can choose *which* offer to accept and can never choose
 * what the case says. That matters more than it looks: this is a "use server" boundary, the case
 * it writes is what a judge will grade a document against, and a prompt posted from the browser
 * would make the eval a claim about whatever the caller sent rather than about the rule.
 *
 * A key that no longer matches any row is **counted, not an error**. The author edited the rule
 * between the page rendering and the button being pressed, and the honest answer is that the
 * offer expired — failing the whole batch over one stale key would lose the other nine accepts.
 */
export async function acceptRuleCases(input: {
  draft: DraftRef;
  orgId: string;
  userId: string | null;
  keys: string[];
}): Promise<AcceptResult> {
  const wanted = new Set(input.keys.slice(0, MAX_RULE_CASE_PROPOSALS));
  if (wanted.size === 0) return { created: 0, missed: 0, ids: [] };

  const report = await proposalsFor(input.draft, input.orgId);
  const byKey = new Map<string, RuleCaseProposal>(report.proposals.map((p) => [p.key, p]));

  const parent = evalParentFor(input.draft);
  const ids: string[] = [];
  let missed = 0;

  for (const key of wanted) {
    const proposal = byKey.get(key);
    if (!proposal) {
      missed += 1;
      continue;
    }
    const result = await createEval({
      ...parent,
      orgId: input.orgId,
      userId: input.userId,
      kind: RULE_CASE_KIND,
      prompt: proposal.prompt,
      expectation: proposal.expectation,
      source: "rule",
      sourceRule: proposal.key,
    });
    /*
     * A refusal here is counted with the stale keys rather than thrown. `createEval` refuses an
     * unjudgeable case, which this path already makes impossible by refusing an empty action —
     * so a refusal means the two disagree, and the right outcome is that the offer stays on
     * screen rather than that nine good accepts are lost to one.
     */
    if (result.ok) ids.push(result.id);
    else missed += 1;
  }

  return { created: ids.length, missed, ids };
}
