import { BLOCK_TYPES, type BlockType } from "./block-types";

/**
 * Interview mode's vocabulary (Doc 6 RW.4, plan step C2b).
 *
 * ## What an interview is for, and why a form cannot do it
 *
 * The builder's wizard asks an author what they want the skill to do and hands the answer to
 * a model. That works, and it captures what somebody can already articulate. The knowledge
 * worth writing down is mostly the other kind: the exception they always make, the case where
 * the obvious procedure is wrong, the thing they check first because of something that went
 * wrong two years ago. Nobody types that into a textarea labelled "purpose", because it does
 * not occur to them that it is unusual.
 *
 * Eliciting it is a known craft with named techniques, and RW.4 names five. Each is a
 * different question shape, and they are separate here rather than being one "be a good
 * interviewer" prompt because an author picks the one that fits what they are trying to get
 * out — and because measuring which technique produced accepted blocks is only possible if
 * the turns say which one they came from.
 *
 * ## Every turn emits typed candidate blocks
 *
 * This is what makes the interview part of the workbench rather than a chat window beside it.
 * A turn does two things: it asks the next question, and it turns what the author just said
 * into **typed blocks the author accepts, rejects or edits**. R5.1 (elicitation) and R5.4
 * (per-suggestion feedback) are the same motion — the accept/reject *is* the feedback, so
 * neither needs a separate surface asking the author to rate anything.
 *
 * ## A leaf module
 *
 * The interview surface is a client component and `src/server/**` is `server-only`. The
 * prompts live server-side; the vocabulary lives here. Same split as every other closed
 * vocabulary in this codebase.
 */

export const INTERVIEW_TECHNIQUES = [
  "episode-walkthrough",
  "contrastive-probing",
  "exception-mining",
  "worked-example",
  "teach-back",
] as const;

export type InterviewTechnique = (typeof INTERVIEW_TECHNIQUES)[number];

export function isInterviewTechnique(value: unknown): value is InterviewTechnique {
  return (
    typeof value === "string" && (INTERVIEW_TECHNIQUES as readonly string[]).includes(value)
  );
}

export type TechniqueMeta = {
  label: string;
  /** What the author gets out of it, in their words rather than in ours. */
  blurb: string;
  /** The block types this technique is trying to produce. Shown, and used in the prompt. */
  targets: BlockType[];
};

export const INTERVIEW_TECHNIQUE_META: Record<InterviewTechnique, TechniqueMeta> = {
  "episode-walkthrough": {
    label: "Walk me through the last time",
    blurb:
      "One real occasion, start to finish. Recalling a specific episode surfaces steps that a description of the process leaves out, because the steps were there and the summary was not.",
    targets: ["procedure", "tool-contract", "decision-rule"],
  },
  "contrastive-probing": {
    label: "What would a novice get wrong",
    blurb:
      "The difference between how you do it and how somebody competent but new would. That gap is the expertise, and it is invisible until something is held next to it.",
    targets: ["decision-rule", "guardrail", "anti-example"],
  },
  "exception-mining": {
    label: "When is the normal answer wrong",
    blurb:
      "The cases where the standard procedure does not apply. Experts carry a long list of these and almost never write them down, because to them they are not exceptions.",
    targets: ["decision-rule", "guardrail", "anti-example"],
  },
  "worked-example": {
    label: "Show me one real input and output",
    blurb:
      "A concrete case with its actual result. The most checkable thing an interview can produce — and the raw material for an eval case.",
    targets: ["example", "output-spec"],
  },
  "teach-back": {
    label: "Let me say it back to you",
    blurb:
      "The assistant states its understanding and you correct it. Corrections are cheaper to give than explanations, and they land on exactly the parts that were wrong.",
    targets: ["trigger", "output-spec", "guardrail"],
  },
};

/**
 * What happened to one suggested block (R5.4).
 *
 * `edited` is kept apart from `accepted` on purpose. Both put a block on the draft, and they
 * are opposite signals about the suggestion: one says the assistant got it right, the other
 * says it was close enough to be worth fixing rather than discarding. Collapsing them would
 * make the accept rate look better than it is, on the one number that says whether Interview
 * mode is working.
 */
export const CANDIDATE_DECISIONS = ["pending", "accepted", "edited", "rejected"] as const;

export type CandidateDecision = (typeof CANDIDATE_DECISIONS)[number];

export function isCandidateDecision(value: unknown): value is CandidateDecision {
  return typeof value === "string" && (CANDIDATE_DECISIONS as readonly string[]).includes(value);
}

/** Who said it. `author` is the person; `assistant` is the model's question. */
export const INTERVIEW_ROLES = ["assistant", "author"] as const;

export type InterviewRole = (typeof INTERVIEW_ROLES)[number];

/**
 * The block types a turn may propose.
 *
 * The whole vocabulary, imported rather than a subset, even though each technique targets a
 * few. A technique's `targets` steer the prompt; they must not *bound* what can be captured,
 * because the most valuable thing an author says is routinely not the thing the question was
 * aiming at — an exception-mining question that produces a tool contract has still produced
 * a tool contract.
 */
export const CANDIDATE_BLOCK_TYPES: readonly BlockType[] = BLOCK_TYPES;

/**
 * How many blocks one turn may propose.
 *
 * Small on purpose. A turn that returns nine candidates turns the accept/reject step into a
 * form to get through, which is the shape RW.4 exists to avoid — and it degrades the signal,
 * because somebody clicking accept nine times is not making nine judgements. Three is enough
 * for a rich answer to produce a rule, its exception and the tool it applies to.
 */
export const MAX_CANDIDATES_PER_TURN = 3;
