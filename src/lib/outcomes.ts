/**
 * Outcome signals: what happened to a skill *after* it was published (Doc 2 R6.3).
 *
 * A leaf module with no imports, like `quality.ts` and `plans.ts`, because the recorder, the
 * lifecycle derivation, the loop dashboard and the reference page all need one vocabulary.
 *
 * ## The half of the loop that was missing
 *
 * Creation telemetry (R6.2) records what happened *while* a skill was written: which
 * archetype sections were offered, kept, and survived to publish. It has been running for a
 * while and it is only half a loop. Everything the platform claims about "what good looks
 * like" is otherwise a statement about **what the corpus contains** — prevalence, lift, the
 * shape of documents other people published — and never about what actually worked.
 *
 * These are the other half. A download is a consumer choosing the skill. A re-validation
 * that still passes is the skill holding up against analyzers that did not exist when it was
 * written. A quarantine on re-validation is the strongest negative signal there is, because
 * nothing about it is an opinion.
 *
 * ## Valence is derived, never stored
 *
 * A stored valence column would let a row's kind and its meaning drift apart, and the drift
 * would be invisible: aggregate queries would keep working and start answering a different
 * question. So the sign of a signal is a function of its kind, computed at read time — the
 * same reasoning that keeps the lifecycle state out of a column.
 *
 * ## What is deliberately not here
 *
 * No identity, no IP, no user agent, no session. The recorder stores a daily-rotating HMAC
 * of the caller key purely so the same reader downloading the same skill twice in a day
 * counts once (R6.5's dedup-per-identity), and that digest is not linkable across days or
 * back to an address. Everything else is a skill id, a kind from this list, and a date.
 */

export const OUTCOME_KINDS = [
  /** A consumer took the bundle from the web registry. The closest thing to an install. */
  "download-web",
  /** A consumer took it through the MCP surface. Same act, different channel. */
  "download-mcp",
  /**
   * Re-validated and still servable.
   *
   * The "age without incident" evidence RK.1 wants for battle-tested, and it is genuinely
   * evidence rather than a restatement of the quality score: it means the skill passed
   * analyzers that may not have existed when it was published.
   */
  "revalidated-pass",
  /**
   * Re-validated and quarantined. The strongest negative signal in the system.
   *
   * Nothing about it is an opinion — an analyzer found something blocking in content that
   * was previously served. If an archetype's skills fail here more often than the corpus
   * average, that is the archetype's problem.
   */
  "revalidated-fail",
  /** Withdrawn following a request (R7.5). Negative, and not the author's fault. */
  "withdrawn",
  /** A curator or author said stop using it (RK.1). */
  "deprecated",
  /** Replaced by a named skill (RK.1). Negative for this skill, neutral for its category. */
  "superseded",
  /**
   * A reader reported a problem and a curator upheld it (R2.5).
   *
   * Written by `upholdFlag`, never by `submitFlag`. That split is the whole design of the
   * flagging surface: an accusation alone must not be able to strip a trust tier, because
   * `flagged` is adverse and adverse outcomes bar `battle-tested`.
   */
  "flagged",
  /**
   * Measured impact from an eval run (RW.7), written by the with/without matrix (D3).
   *
   * The signal R6.3 most wants, and the one that was furthest away because it needed the Eval
   * Lab to exist. `value` is the delta — pass rate with the skill minus pass rate without it,
   * averaged over the models — and it is **signed**: a skill that made results worse records a
   * negative, which is the finding this whole milestone exists to surface.
   *
   * Only for a published skill. The signal attaches to a `skill_version` and a draft has none,
   * so a matrix run while authoring measures without recording.
   */
  "eval-delta",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export function isOutcomeKind(value: unknown): value is OutcomeKind {
  return typeof value === "string" && (OUTCOME_KINDS as readonly string[]).includes(value);
}

/**
 * Kinds nothing writes yet, so a dashboard can say "not collected" rather than "none".
 *
 * The distinction is worth a list rather than a query: "implemented and nobody has done it
 * yet" and "no code path can produce this" are opposite facts that both show as zero rows,
 * and only the first should read as *none so far*.
 *
 * **This list drifted once and shipped a wrong sentence to an operator.** `flagged` stayed
 * on it after `upholdFlag` began writing the row, so Settings → Loop reported *"Not collected
 * yet: flagged. Flagging needs a reader route (R2.5)"* on a platform that had one and was
 * recording through it. The panel understated its own collection and repeated a dependency
 * that no longer existed — the same shape as a status command measuring the gate with
 * something that is not the gate.
 *
 * A hand-maintained list cannot be derived from the data, so it is **checked against the
 * data instead**: `verify:outcomes` asserts every kind named here has zero stored rows. Write
 * one and the suite goes red, naming the kind to remove. That is the only mechanism that
 * makes forgetting this list loud rather than silent.
 */
/*
 * Empty as of plan step D3, and that is the whole of R6.3's collection half.
 *
 * The list stays — it is a statement about the code that cannot be derived, and the next kind
 * added will need it again. `verify:outcomes` asserts every kind named here has zero stored
 * rows, so leaving `eval-delta` on it after the matrix began writing would have turned the Loop
 * panel red rather than merely stale. That is the correction the `flagged` entry had to make
 * the hard way.
 */
export const UNIMPLEMENTED_KINDS: readonly OutcomeKind[] = [];

/**
 * Why each uncollected kind is uncollected, so the sentence cannot outlive its reason.
 *
 * The panel used to carry the reasons as prose — *"Flagging needs a reader route (R2.5); eval
 * deltas need the Eval Lab"* — which is how the stale claim survived: the list shrank in one
 * file and the explanation lived in another. Keyed off the same kind, a reason disappears
 * exactly when the kind does.
 */
export const UNIMPLEMENTED_REASON: Record<string, string> = {};

export type Valence = "positive" | "negative" | "neutral";

/**
 * The sign of a signal.
 *
 * `superseded` is **neutral**, which is the one judgement here worth arguing about. For the
 * skill it is an ending; for the *category* it is a healthy one — somebody wrote something
 * better and said so. Counting it against an archetype would punish the categories where
 * authors iterate most, which is the opposite of what the loop should reward.
 *
 * `withdrawn` is negative but excluded from an author's own record elsewhere: a takedown is
 * a licence or legal outcome, not a quality one.
 */
const VALENCE: Record<OutcomeKind, Valence> = {
  "download-web": "positive",
  "download-mcp": "positive",
  "revalidated-pass": "positive",
  "revalidated-fail": "negative",
  withdrawn: "negative",
  deprecated: "negative",
  superseded: "neutral",
  flagged: "negative",
  "eval-delta": "neutral",
};

export function valenceOf(kind: OutcomeKind): Valence {
  return VALENCE[kind];
}

/** The two download channels, for the places that want installs as one number. */
export const DOWNLOAD_KINDS: readonly OutcomeKind[] = ["download-web", "download-mcp"];

export function isDownload(kind: OutcomeKind): boolean {
  return DOWNLOAD_KINDS.includes(kind);
}

/**
 * An adverse outcome bars `battle-tested` outright (RK.1).
 *
 * Separate from "negative valence" on purpose: `superseded` is not adverse, and a skill that
 * was superseded because something better exists should not be treated as one that failed
 * re-validation. This is the list the lifecycle derivation reads.
 */
export const ADVERSE_KINDS: readonly OutcomeKind[] = [
  "revalidated-fail",
  "withdrawn",
  "deprecated",
  "flagged",
];

export const OUTCOME_META: Record<OutcomeKind, { label: string; blurb: string }> = {
  "download-web": { label: "Downloaded (web)", blurb: "A reader took the bundle from the registry." },
  "download-mcp": { label: "Downloaded (agent)", blurb: "An agent took it over MCP." },
  "revalidated-pass": {
    label: "Held up",
    blurb: "Re-validated against current analyzers and still servable.",
  },
  "revalidated-fail": {
    label: "Failed re-validation",
    blurb: "A later analyzer found something blocking in content that had been served.",
  },
  withdrawn: { label: "Withdrawn", blurb: "Removed following a request." },
  deprecated: { label: "Deprecated", blurb: "A curator or author asked that it not be used." },
  superseded: { label: "Superseded", blurb: "Replaced by a named skill." },
  flagged: { label: "Flagged", blurb: "A reader reported a problem." },
  "eval-delta": { label: "Eval delta", blurb: "Measured impact with the skill versus without." },
};

/**
 * What `battle-tested` costs to earn (RK.1).
 *
 * Deliberately conservative, and every number is a judgement rather than a measurement —
 * there is no outcome data yet to tune against, so these are set where a reader would find
 * the badge credible and can be lowered with evidence later. Lowering a trust threshold
 * because nothing qualifies would be the worst possible reason to move one.
 *
 * The `age` term is what stops the badge being a download counter: a skill that was
 * published yesterday and downloaded fifty times has been popular, not proven.
 */
export const BATTLE_TESTED = {
  /** Deduplicated downloads, across both channels. */
  minDownloads: 25,
  /** Days since the skill was first indexed. */
  minAgeDays: 30,
  /** At least one re-validation that still passed, so it has met a newer analyzer. */
  minRevalidations: 1,
  /** Any adverse outcome, ever, disqualifies it. */
  adverseAllowed: 0,
} as const;
