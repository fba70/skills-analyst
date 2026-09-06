/**
 * The skill lifecycle (Doc 6 RK.1) — how proven a skill is, not whether it is safe.
 *
 * A leaf module with no imports, same reason as `quality.ts` and `tokens.ts`: the badge, the
 * reference page and the CLI all need one vocabulary.
 *
 * ## Why this is a second axis and not more values on `status`
 *
 * `skills.status` answers **may we serve this** — pending, indexed, quarantined, tombstoned,
 * withdrawn. It is a trust decision, fail-closed, and the pipeline owns it.
 *
 * Lifecycle answers a question static scanning cannot reach: **how much has this been
 * proven, and is it still current.** A skill can be perfectly valid and three years stale;
 * it can be superseded by a better one and still pass every analyzer. Folding those into
 * `status` would mean a takedown, a failed scan and an author's deprecation notice all
 * competing for one column, and the pipeline overwriting a human's declaration on the next
 * sync — the "recorded then ignored" shape this codebase has already hit three times.
 *
 * ## Most of it is derived, and that is the whole design
 *
 * Doc 6 is specific: **battle-tested is earned by evidence, not by static checks**, and
 * **stale is detected, not declared**. The honest way to hold a system to that is to leave
 * it no column to cheat with. So only the two states a human genuinely asserts —
 * `deprecated` and `superseded` — are stored, and the rest is computed from evidence every
 * time it is read (`src/server/skills/lifecycle.ts`). Nobody can hand a skill a
 * battle-tested badge, because there is nowhere to write one.
 *
 * ## `draft` is deliberately not in this list
 *
 * Doc 6's chain opens with it, and on this schema it cannot occur: a row in `skills` exists
 * because something was published, and an unpublished draft lives in `skill_drafts` with its
 * own status. Carrying a value nothing can ever hold is how a vocabulary starts lying about
 * the space it describes — the same fault as reporting thirteen archetype-ready categories
 * when the miner refused one of them.
 */

export const LIFECYCLE_STATES = [
  /** Passed the pipeline and is served. The floor for anything in the registry. */
  "validated",
  /**
   * Earned above `validated` by post-publication evidence (RK.1).
   *
   * **Unreachable today, by construction.** It needs outcome telemetry — R6.3, plan step
   * B1 — and until that exists there is no evidence to earn it with, so the derivation does
   * not have a branch for it and `verify:lifecycle` asserts no skill carries it. The value
   * lives here because the trust surface has to be able to name the tier it is missing;
   * shipping a badge nothing can hold would be worse than saying so.
   */
  "battle-tested",
  /** Detected, never declared: the review-by date has passed, or a freshness signal fired. */
  "stale",
  /** The author or a curator says do not use this any more. */
  "deprecated",
  /** Replaced by a named skill. Supersession is semantic, unlike a tombstone. */
  "superseded",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** The two a human asserts. Everything else is computed — see the note above. */
export const LIFECYCLE_DECLARATIONS = ["deprecated", "superseded"] as const;

export type LifecycleDeclaration = (typeof LIFECYCLE_DECLARATIONS)[number];

export function isLifecycleDeclaration(value: unknown): value is LifecycleDeclaration {
  return (
    typeof value === "string" && (LIFECYCLE_DECLARATIONS as readonly string[]).includes(value)
  );
}

export type LifecycleMeta = {
  label: string;
  /** One line a reader can act on. */
  blurb: string;
  /** Whether it is asserted by a person or computed from evidence. */
  origin: "declared" | "derived" | "earned";
  /** How a badge should read: neutral, positive, cautionary, or negative. */
  tone: "neutral" | "good" | "warn" | "bad";
};

export const LIFECYCLE_META: Record<LifecycleState, LifecycleMeta> = {
  validated: {
    label: "Validated",
    blurb: "Passed every analyzer and is served. The floor for anything listed here.",
    origin: "derived",
    tone: "neutral",
  },
  "battle-tested": {
    label: "Battle-tested",
    blurb:
      "Proven in use, not just scanned — earned from post-publication evidence rather than granted.",
    origin: "earned",
    tone: "good",
  },
  stale: {
    label: "Stale",
    blurb: "Past its review date. The content may still be fine; nobody has checked lately.",
    origin: "derived",
    tone: "warn",
  },
  deprecated: {
    label: "Deprecated",
    blurb: "Its author or a curator has asked that it no longer be used.",
    origin: "declared",
    tone: "bad",
  },
  superseded: {
    label: "Superseded",
    blurb: "Replaced by a named skill, which is linked from this page.",
    origin: "declared",
    tone: "bad",
  },
};

export function lifecycleLabel(state: string): string {
  return LIFECYCLE_META[state as LifecycleState]?.label ?? state;
}

/**
 * States that should temper a reader's confidence, in the order a badge should shout.
 *
 * Exported so a listing can sort or filter on "needs attention" without restating the set —
 * and so adding a state forces a decision about which side of this line it falls on.
 */
export const LIFECYCLE_CAUTION: readonly LifecycleState[] = ["superseded", "deprecated", "stale"];

export function isCautionState(state: string | null): boolean {
  return state !== null && (LIFECYCLE_CAUTION as readonly string[]).includes(state);
}
