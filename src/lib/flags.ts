/**
 * Community flagging (Doc 2 R2.5) — the route from a reader to the quarantine queue.
 *
 * A leaf module with no imports, like `quality.ts` and `outcomes.ts`: the public form, the
 * curator queue and the reference page all need one vocabulary.
 *
 * ## Why this exists
 *
 * R2.5 has been the oldest unclosed P0 in the validation half. Until now the only way a bad
 * skill got re-examined was an analyzer bump — so a reader who spotted something the
 * analyzers missed had nowhere to put it, which is the one class of finding automation
 * cannot produce.
 *
 * ## A flag never enforces anything, and that is the whole design
 *
 * A flag lands as `received` and stays there until a curator decides. It quarantines nothing,
 * hides nothing and changes no score.
 *
 * That is not caution, it is the only workable posture. Enforcing on arrival means **anybody
 * who can fill in a form can un-list a competitor**, which is the failure every takedown
 * regime is criticised for and the reason `takedowns` already separates recording from
 * deciding. The temptation is strongest for the security reasons — surely a credible
 * exfiltration report should hide the skill immediately? — and that is exactly the reason an
 * attacker would reach for `malicious` first.
 *
 * The same logic governs the outcome signal (R6.3): only an **upheld** flag records one.
 * A received flag that counted would let anyone manufacture negative evidence against a
 * skill, and since `flagged` is an adverse outcome it would bar that skill from
 * `battle-tested` on nothing but an accusation.
 */

export const FLAG_REASONS = [
  /** Tries to exfiltrate data, hijack the agent, or run something it did not disclose. */
  "malicious",
  /** Contains instructions aimed at the *consuming* agent rather than describing the skill. */
  "prompt-injection",
  /** Contains a credential, token or key. */
  "secret",
  /** The documentation does not describe what it actually does. */
  "misleading",
  /** Refers to files, tools or APIs that do not exist, or simply does not work. */
  "broken",
  /** The licence recorded here looks wrong. Not a takedown — a metadata correction. */
  "licence",
  /** A copy of another skill, presented as its own. */
  "duplicate",
  /** Anything else worth a curator's attention. */
  "other",
] as const;

export type FlagReason = (typeof FLAG_REASONS)[number];

export function isFlagReason(value: unknown): value is FlagReason {
  return typeof value === "string" && (FLAG_REASONS as readonly string[]).includes(value);
}

export const FLAG_STATUSES = ["received", "upheld", "rejected"] as const;

export type FlagStatus = (typeof FLAG_STATUSES)[number];

/**
 * How urgently a curator should look, derived from the reason rather than stored.
 *
 * Derived for the same reason outcome valence is: a stored priority column would let a row's
 * reason and its urgency drift apart, and the drift would be invisible because the queue
 * would keep sorting.
 *
 * **This orders the queue; it does not gate anything.** A `security` flag is read first and
 * still enforces nothing on arrival — see the note at the top of this file.
 */
export type Triage = "security" | "quality" | "metadata";

const TRIAGE: Record<FlagReason, Triage> = {
  malicious: "security",
  "prompt-injection": "security",
  secret: "security",
  misleading: "quality",
  broken: "quality",
  duplicate: "quality",
  licence: "metadata",
  other: "quality",
};

export function triageOf(reason: FlagReason): Triage {
  return TRIAGE[reason];
}

/** Read-first order for the curator queue. */
export const TRIAGE_ORDER: Record<Triage, number> = { security: 0, quality: 1, metadata: 2 };

export type FlagReasonMeta = {
  /** What a reader sees in the form. Written as the reader's own observation. */
  label: string;
  /** One line, so somebody choosing between two reasons can tell them apart. */
  blurb: string;
};

export const FLAG_REASON_META: Record<FlagReason, FlagReasonMeta> = {
  malicious: {
    label: "It looks malicious",
    blurb: "Tries to take data, run something undisclosed, or steer the agent somewhere bad.",
  },
  "prompt-injection": {
    label: "It contains hidden instructions",
    blurb: "Text aimed at the agent reading it, rather than a description of the skill.",
  },
  secret: {
    label: "It contains a credential",
    blurb: "A key, token or password is in the content.",
  },
  misleading: {
    label: "It does not do what it says",
    blurb: "The description and the actual behaviour do not match.",
  },
  broken: {
    label: "It does not work",
    blurb: "Refers to files, tools or APIs that are missing, or fails when used.",
  },
  licence: {
    label: "The licence looks wrong",
    blurb: "The licence shown here does not match the source.",
  },
  duplicate: {
    label: "It is a copy of another skill",
    blurb: "Republished from somewhere else without saying so.",
  },
  other: { label: "Something else", blurb: "Anything a curator should look at." },
};

/**
 * Cap on the reader's note.
 *
 * Long enough for a paragraph naming a file and a line, short enough that the field is not a
 * channel for pasting a payload. The note is **untrusted input** wherever it is shown or
 * summarised (R7.3), and it is never rendered as markup.
 */
export const MAX_FLAG_NOTE = 1_000;

/** Cap on the optional contact address, if a reporter offers one. */
export const MAX_FLAG_CONTACT = 200;
