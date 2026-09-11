import {
  foldName,
  textHash,
  RULE_OPERATOR_LABEL,
  type RuleCondition,
  type RuleRow,
} from "@/lib/parameters";

/**
 * Every table row is a test case waiting to be accepted (Doc 7 RD.4, plan step P6).
 *
 * ## Why this is the requirement that justifies the structure
 *
 * P4 made a decision rule into rows, and P4's coverage figure is a claim about the *document*:
 * this many declared values have a rule. Coverage with a passing golden task per row is a claim
 * about **behaviour**, and that is the difference between a document that says what to do and a
 * skill that does it.
 *
 * It also costs nothing to propose. A golden task from a structured row is a **render** — the
 * conditions frame the request, the author's action is the expectation — so this module calls no
 * model, reaches no database, and returns the same bytes every time. The Eval Lab's price is paid
 * when somebody runs the case, which is where it belongs.
 *
 * ## Proposed, never created
 *
 * Nothing here writes. A row produces an offer the author accepts one at a time or in a batch, and
 * an unaccepted offer changes nothing about the draft. The same restraint C1b's "add one here" and
 * the block library's missing copy button show: the platform may say *here is a case you could
 * have*, and may not put one in somebody's workspace because a rule exists.
 *
 * ## The expectation is the author's sentence, verbatim
 *
 * No model rewrites it into test-shaped prose, and no heuristic tidies it. The action is what the
 * author said should happen, and a case whose expectation is our paraphrase of that would be
 * judging the skill against words nobody wrote — the line the interview holds when it refuses to
 * infer the two halves of a worked example, and the reason `purpose` is not filled from an
 * imported description.
 */

/** A row proposes exactly one kind of case. Trigger probes read the description; see below. */
export const RULE_CASE_KIND = "golden-task" as const;

/**
 * Why a row proposes nothing. Each is a refusal rather than an omission, and the panel prints
 * them, because *no rules have structure* and *every row already has a case* are the same empty
 * list and opposite conclusions.
 */
export const RULE_CASE_SKIPS = ["otherwise-row", "no-action", "no-conditions"] as const;

export type RuleCaseSkip = (typeof RULE_CASE_SKIPS)[number];

export const RULE_CASE_SKIP_MESSAGE: Record<RuleCaseSkip, string> = {
  /*
   * An `otherwise` row is defined by what it is *not*. Framing it as a request means enumerating
   * every case the other rows cover and asking for one outside that set — which is a different
   * question from the one the author wrote, and a prompt reading "some other case" tests nothing.
   */
  "otherwise-row": "An otherwise row has no case to frame a request from.",
  "no-action": "This row says nothing to do yet, so there is nothing for a judge to check.",
  "no-conditions": "This row names no parameter, so there is no situation to put to the agent.",
};

export type RuleCaseProposal = {
  /**
   * Stable identity of the claim this row makes. Content, never position: rows have no id, and a
   * position would re-point every case below an inserted row.
   */
  key: string;
  blockId: string;
  /** Where the row sits today. For display only — never part of the key. */
  row: number;
  kind: typeof RULE_CASE_KIND;
  prompt: string;
  expectation: string;
};

export type RuleCaseSkipped = { blockId: string; row: number; reason: RuleCaseSkip };

export type RuleCaseReport = {
  proposals: RuleCaseProposal[];
  /** Rows whose case already exists. Not a proposal, and not a problem. */
  covered: number;
  skipped: RuleCaseSkipped[];
  /**
   * Decision-rule blocks with confirmed, in-step structure. **Zero means nothing was measured**
   * — a draft whose rules are still prose — which is a different sentence from "every row is
   * covered", and the panel must be able to tell a reader which one it is looking at.
   */
  blocks: number;
  rows: number;
  /** Proposals beyond the cap, counted rather than listed. */
  more: number;
};

/**
 * How many offers are listed at once.
 *
 * Below `MAX_CASES_PER_RUN`, deliberately: a list an author can accept in full and then run in
 * one press is a list that gets used, and one that spills over two runs invites half of it being
 * forgotten. A forty-row table reports the remainder rather than rendering forty buttons.
 */
export const MAX_RULE_CASE_PROPOSALS = 20;

/**
 * The claim a row makes, folded to a key.
 *
 * Three decisions inside this, each about what should and should not re-propose:
 *
 * - **The block id is not in it.** P4's "make this a table" moves rows from several blocks into
 *   one, and a key carrying the block would break every link the merge touched — the author
 *   consolidating their rules would be told their cases had vanished.
 * - **Conditions are sorted.** Reordering `when` changes the rendered sentence and not the claim,
 *   so it must not produce a second proposal for a decision already tested.
 * - **The action is folded, not hashed raw.** Fixing a capital letter is not a new expectation;
 *   rewriting the action is, and that re-proposes on purpose. The case already accepted is left
 *   exactly where it is — it is the author's now, and deleting somebody's test because they
 *   edited the rule it came from would be the worst possible reading of "derived".
 */
export function ruleCaseKey(row: RuleRow): string {
  const conditions = row.when
    .map((c) => `${foldName(c.parameter)}|${c.op}|${foldName(c.value)}`)
    .sort()
    .join(";");
  return textHash(`${conditions}=>${foldName(row.then)}`);
}

/**
 * One condition as plain prose.
 *
 * Plain, where `renderRule` emits bold and backticks: this string is handed to a model as a
 * request, and markup in a request is noise the agent has to read past. The operator words come
 * from `RULE_OPERATOR_LABEL` rather than a second table of them, so the sentence an author reads
 * in their document and the sentence a probe puts to an agent cannot drift apart.
 */
export function conditionPhrase(c: RuleCondition): string {
  const name = c.parameter.trim();
  const value = c.value.trim();
  if (c.op === "in") {
    const values = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return `${name} is ${values.join(" or ")}`;
  }
  return `${name} ${RULE_OPERATOR_LABEL[c.op]} ${value}`;
}

/**
 * The request a row becomes.
 *
 * It names the situation and asks what to do, and it deliberately does **not** mention the skill.
 * A prompt reading *"what does this skill say"* would be unanswerable in D3's without-arm, which
 * runs the identical prompt with the document withheld — and that arm is the whole point of
 * having the case: a rule the model reproduces unaided is a rule carrying no knowledge the agent
 * lacked, which is the finding an author is least likely to look for and most needs.
 */
export function ruleCasePrompt(row: RuleRow): string {
  return `Given that ${row.when.map(conditionPhrase).join(" and ")}, what should be done?`;
}

/**
 * A row's proposal, or the reason it has none.
 *
 * Pure and total: every row gets an answer, and the caller never has to guess why one is absent.
 */
export function proposeFor(
  blockId: string,
  row: RuleRow,
  index: number,
): RuleCaseProposal | RuleCaseSkipped {
  const skip = (reason: RuleCaseSkip): RuleCaseSkipped => ({ blockId, row: index, reason });
  if (row.otherwise) return skip("otherwise-row");
  if (row.when.length === 0) return skip("no-conditions");
  /*
   * The empty action is the one this has to catch. "Add a rule here" writes a row with the
   * condition filled and the action left as the author's to write, and a golden task with no
   * expectation is unjudgeable — it would fail every run for our reason rather than the skill's,
   * which is precisely the distinction `error` exists to keep out of `fail`.
   */
  if (!row.then.trim()) return skip("no-action");
  return {
    key: ruleCaseKey(row),
    blockId,
    row: index,
    kind: RULE_CASE_KIND,
    prompt: ruleCasePrompt(row),
    /* Verbatim. Trimmed, because trailing space is not the author's sentence either. */
    expectation: row.then.trim(),
  };
}

export function isRuleCaseProposal(
  value: RuleCaseProposal | RuleCaseSkipped,
): value is RuleCaseProposal {
  return "key" in value;
}

/**
 * Every in-step row of every structured block, against the keys already taken.
 *
 * `taken` is the set of `source_rule` values on the draft's existing cases, so a proposal
 * disappears the moment its case exists and comes back if that case is deleted — resolved live,
 * like every other pointer here, rather than a flag somebody has to remember to clear.
 *
 * Only **in-step** blocks are handed in by the caller, for the reason coverage counts only those:
 * a candidate is a structure a model guessed at and a detached one describes a sentence that no
 * longer exists, and a case generated from either would test a rule the document does not make.
 */
export function ruleCaseReport(
  blocks: ReadonlyArray<{ id: string; rows: RuleRow[] }>,
  taken: ReadonlySet<string>,
): RuleCaseReport {
  const proposals: RuleCaseProposal[] = [];
  const skipped: RuleCaseSkipped[] = [];
  const seen = new Set<string>();
  let covered = 0;
  let rows = 0;

  for (const block of blocks) {
    for (const [index, row] of block.rows.entries()) {
      rows += 1;
      const outcome = proposeFor(block.id, row, index);
      if (!isRuleCaseProposal(outcome)) {
        skipped.push(outcome);
        continue;
      }
      if (taken.has(outcome.key)) {
        covered += 1;
        continue;
      }
      /*
       * Two rows making the identical claim are one proposal. A merged table can genuinely hold
       * the same row twice, and offering the same case twice would have the author accept a
       * duplicate that then costs a model call on every run for ever.
       */
      if (seen.has(outcome.key)) {
        covered += 1;
        continue;
      }
      seen.add(outcome.key);
      proposals.push(outcome);
    }
  }

  return {
    proposals: proposals.slice(0, MAX_RULE_CASE_PROPOSALS),
    covered,
    skipped,
    blocks: blocks.length,
    rows,
    more: Math.max(0, proposals.length - MAX_RULE_CASE_PROPOSALS),
  };
}
