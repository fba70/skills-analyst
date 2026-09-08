/**
 * The knowledge graph (Doc 6 RK.3, plan step E2).
 *
 * ## Most of this graph is not stored, and that is the design
 *
 * The obvious build is one `skill_relations` table holding every edge — similar-to, supersedes,
 * conflicts-with, declared. It is also three second sources of truth:
 *
 * - **`similar-to` already lives in the A6 vectors.** A stored copy is a snapshot that goes stale
 *   the moment a skill is re-embedded, and resolving it live is a `<=>` lookup against an index
 *   that exists — free, and correct by construction.
 * - **`supersedes` already lives on `skills.superseded_by`.** A4 made that a declaration with a
 *   live join precisely so a replacement quarantined since would stop being recommended; copying
 *   it into an edge table would resurrect exactly the stale-pointer problem A4 solved.
 *
 * So the table holds the two kinds with nowhere else to live: **author-declared** edges, and
 * **mined conflicts**, which cost a model call per pair and therefore have to be remembered.
 * `relationsFor` composes all four at read time, and which are stored is an implementation
 * detail rather than something a caller has to know.
 *
 * ## The conflict half has no equivalent anywhere in the system
 *
 * Everything else the platform says about a skill is about that skill. This is the first claim
 * about a *pair*: install both and one tells the agent always, the other never. Nothing in
 * validation can see it, because each document is individually fine.
 */

export const RELATION_KINDS = [
  "similar-to",
  "supersedes",
  "superseded-by",
  "conflicts-with",
  "requires",
  "part-of",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === "string" && (RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * Which kinds may be written to `skill_relations`.
 *
 * The others are derived, and a writer that accepted them would be creating the stale copy the
 * module comment exists to prevent. Enforced rather than documented: `declareRelation` refuses.
 */
export const STORED_KINDS: readonly RelationKind[] = [
  "conflicts-with",
  "requires",
  "part-of",
];

/** Symmetric kinds mean the same thing read from either end. */
export const SYMMETRIC_KINDS: readonly RelationKind[] = ["similar-to", "conflicts-with"];

export function isSymmetric(kind: RelationKind): boolean {
  return SYMMETRIC_KINDS.includes(kind);
}

export const RELATION_META: Record<
  RelationKind,
  { label: string; blurb: string; caution: boolean }
> = {
  "similar-to": {
    label: "Similar to",
    blurb: "Close in what it claims to do. Resolved live from the embedding index.",
    caution: false,
  },
  supersedes: {
    label: "Replaces",
    blurb: "A curator said this is the newer answer.",
    caution: false,
  },
  "superseded-by": {
    label: "Replaced by",
    blurb: "A curator pointed somewhere better.",
    caution: true,
  },
  "conflicts-with": {
    label: "Conflicts with",
    blurb: "Their guardrails disagree. Installing both gives an agent contradictory instructions.",
    caution: true,
  },
  requires: {
    label: "Requires",
    blurb: "Declared by an author: this one expects the other to be present.",
    caution: false,
  },
  "part-of": {
    label: "Part of",
    blurb: "Declared by an author: one piece of a larger set.",
    caution: false,
  },
};

/** Who said so. A mined edge is evidence; a declared one is somebody's assertion. */
export const RELATION_SOURCES = ["declared", "mined"] as const;

export type RelationSource = (typeof RELATION_SOURCES)[number];

export type Relation = {
  kind: RelationKind;
  source: RelationSource;
  slug: string;
  name: string;
  /** Why, in one line. The conflicting guardrail pair for a mined conflict. */
  detail: string | null;
  /** 0–1 for a live similarity edge; null for everything else. */
  similarity: number | null;
};

/**
 * Bumped when the conflict detector changes what it would decide.
 *
 * Stored on every mined row, for the reason `MINER_VERSION` and `EXTRACTOR_VERSION` exist: a
 * conflict is a claim somebody will act on, and "which rules produced this" has to be answerable
 * after the rules move. It is also the re-mine selector.
 */
export const CONFLICT_MINER_VERSION = "1.0.0";

/**
 * How close two skills must be before their guardrails are worth comparing.
 *
 * Contradiction needs shared territory: a Terraform guardrail and a legal-review guardrail cannot
 * disagree, they are simply about different things. Below this the model call would be spent
 * establishing that, thousands of times.
 */
export const CONFLICT_MIN_SIMILARITY = 0.6;

/** Neighbours considered per skill. An agent picks from a handful, not from the corpus. */
export const CONFLICT_NEIGHBOURS = 5;

/**
 * Guardrails from each side sent in one call.
 *
 * One call per *pair*, not per guardrail pair — the model is given both sets and asked which
 * cross-pairs contradict. The quadratic version is the obvious one and is the difference between
 * a job that finishes and one that does not.
 */
export const MAX_GUARDRAILS_PER_SIDE = 8;
