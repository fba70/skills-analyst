/**
 * The block taxonomy (Doc 6 RW.1) — the functional units a skill document is made of.
 *
 * ## Why this exists beside `section-roles.ts` rather than inside it
 *
 * A section role answers *what is this heading about*. A block type answers *what work is
 * this passage doing*. They are different questions at different grains, and the corpus
 * proved the first one is no longer enough: at 97% coverage the strong and weak bands write
 * `steps` at 67% and 55%, so the presence of a heading has stopped discriminating (see the
 * v8 note in CLAUDE.md). Everyone writes `steps` now. Not everyone writes a *guardrail* or
 * an *anti-example* inside it.
 *
 * A block is therefore a span inside a section, typed by what it does. One `steps` section
 * routinely contains a procedure, two guardrails and a tool contract; an archetype that can
 * only say "this category has a steps section" cannot tell an author which of those four
 * the good skills in their category actually carry.
 *
 * ## This module is the canonical list, not a mirror of one
 *
 * `section-roles.ts` duplicates its keys from a `server-only` module and says so, because
 * the vocabulary was born inside the extractor. That duplication is a standing hazard — a
 * role added on one side and not the other degrades silently. So the block vocabulary is
 * defined *here*, in a leaf module with no imports, and the `server-only` detector imports
 * it. Same direction as `capabilities.ts` and `quality.ts`: the closed vocabulary lives
 * where both the server and a client component can reach it, and there is exactly one copy.
 *
 * ## The types are detected and suggested, never mandatory
 *
 * Doc 6 §7 names the risk this taxonomy runs: it could become a schema authors fight. So a
 * passage that matches nothing is typed `null` and stays valid content — the same posture
 * the heading rules already take with genuinely topical headings. The share of unclassified
 * blocks is reported rather than hidden, because that share is the honest measure of whether
 * this vocabulary earns its keep. If a type never separates the bands in any category, it
 * gets pruned, and the number that decides is one this module makes visible.
 */

export const BLOCK_TYPES = [
  /** When the agent should reach for this skill. The triggering contract, in prose. */
  "trigger",
  /** How the agent should position itself — persona, role, voice. */
  "stance",
  /** An ordered procedure of two or more steps. */
  "procedure",
  /** If/then branching: a case and what to do about it. */
  "decision-rule",
  /** A constraint. The musts and the nevers, unconditional. */
  "guardrail",
  /** A worked example: real input and the output it produces. */
  "example",
  /** A named failure mode, with what goes wrong. The rarest and most valuable type. */
  "anti-example",
  /** How to invoke a script, CLI or tool. Should match the capability surface (R2.4). */
  "tool-contract",
  /** The shape the answer must take, precisely enough to be checked. */
  "output-spec",
  /** Domain terminology, defined. */
  "glossary",
  /** A pointer into bundled files or external material — progressive disclosure (R2.7). */
  "reference-pointer",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/** Runtime guard, for anything crossing a boundary (a database row, a model's output). */
export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * The shape of the passage, before anything is said about what it means.
 *
 * Kept separate from the type because the two are independent and both matter: a procedure
 * written as an ordered list and one written as five paragraphs are the same block type and
 * are not equally usable, and that difference is measurable without a model.
 */
export const BLOCK_KINDS = ["paragraph", "list", "code", "table", "quote"] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

export type BlockTypeMeta = {
  /** Sentence case, as it would appear as a label in the workbench. */
  label: string;
  /** One line: what an author actually puts in one. */
  blurb: string;
  /**
   * The quality signal this type carries (Doc 6 §2, third column).
   *
   * Recorded because it is the argument for the type existing at all, and because each one
   * names a later feature: trigger → RW.8's precision lab, example → RW.6's eval cases,
   * tool contract → R2.4's capability surface, guardrail → RK.3's conflict detection.
   */
  signal: string;
};

export const BLOCK_TYPE_META: Record<BlockType, BlockTypeMeta> = {
  trigger: {
    label: "Trigger",
    blurb: "When an agent should reach for this skill, and when it should not.",
    signal: "Triggering precision and recall — testable against a probe set (RW.8).",
  },
  stance: {
    label: "Stance",
    blurb: "The role the agent adopts: who it is being while it does this work.",
    signal: "Consistency with how the rest of the category positions itself.",
  },
  procedure: {
    label: "Procedure",
    blurb: "The ordered steps, in the order they happen.",
    signal: "Step completeness, and whether each step is verifiable.",
  },
  "decision-rule": {
    label: "Decision rule",
    blurb: "A case and what to do about it — if this, then that.",
    signal: "Coverage of the case space: how much of the real decision is written down.",
  },
  guardrail: {
    label: "Guardrail",
    blurb: "A hard constraint. What must always happen, and what must never.",
    signal: "Correlates with passing validation; the input to conflict detection (RK.3).",
  },
  example: {
    label: "Example",
    blurb: "One real input and the output it should produce.",
    signal: "Convertible straight into an eval case (RW.6).",
  },
  "anti-example": {
    label: "Anti-example",
    blurb: "A way this goes wrong, named — the mistake a competent novice makes.",
    signal: "The rarest block type in the corpus, and the one generic generation never writes.",
  },
  "tool-contract": {
    label: "Tool contract",
    blurb: "How to invoke a script or command, with its arguments and what it returns.",
    signal: "Should agree with the measured capability surface (R2.4).",
  },
  "output-spec": {
    label: "Output spec",
    blurb: "The shape of the result, stated tightly enough to check mechanically.",
    signal: "Lintability — whether a result can be judged without a human reading it.",
  },
  glossary: {
    label: "Glossary",
    blurb: "The domain words this skill uses, defined.",
    signal: "Disambiguation: how much guessing the agent is left to do.",
  },
  "reference-pointer": {
    label: "Reference pointer",
    blurb: "A pointer to detail held elsewhere, so the main document stays short.",
    signal: "Disclosure hygiene (R2.7) — real offloading versus a monolith with links.",
  },
};

export function blockTypeLabel(type: string): string {
  return BLOCK_TYPE_META[type as BlockType]?.label ?? type.replace(/-/g, " ");
}

export function blockTypeBlurb(type: string): string {
  return BLOCK_TYPE_META[type as BlockType]?.blurb ?? "A passage the extractor recognised.";
}

/** Unclassified blocks are content, not errors. The label says so on any surface. */
export const UNCLASSIFIED_BLOCK_LABEL = "Unclassified";
