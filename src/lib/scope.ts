/**
 * Scope analysis and disclosure restructuring (Doc 6 RW.10 / RW.11, plan step C5).
 *
 * ## Two questions about a document's shape, neither of which any existing surface asks
 *
 * The analyzers ask whether a skill is well-formed. The archetype asks whether its structure
 * matches what the corpus rewards. A3 asks what it costs to load. None of them asks the two
 * questions a KM practitioner asks first:
 *
 * - **RW.10 — is this one skill or three?** *One asset, one purpose.* A document that covers
 *   two unrelated jobs triggers on both and does neither cleanly, and its author usually cannot
 *   see it, because each half was added for a good reason on a different day.
 * - **RW.11 — does the detail belong in the body?** A skill is paid for in context tokens on
 *   every activation. Deep material that is read occasionally belongs in `references/` behind a
 *   pointer, which is progressive disclosure and is what the corpus already rewards: the miner
 *   measures *offloads detail into `references/`* at +12 to +26 lift.
 *
 * ## The maths lives here, with no imports, because that is what makes it checkable
 *
 * Every function below is pure: vectors in, numbers out. No database, no network, no model. So
 * `verify:scope` can construct a document that is obviously two topics, one that is obviously
 * one, and one whose split is an artefact — and assert the metric separates them — without a
 * corpus, an API key or a fixture that might have stopped reproducing the bug. Same reason
 * `src/lib/quality.ts` and `src/lib/tokens.ts` are leaves.
 *
 * ## The confound this module exists to refuse
 *
 * Cluster a document's blocks and you will always get two clusters; the question is what they
 * are clusters *of*. Guardrails read like other guardrails and procedures read like other
 * procedures, so the strongest signal in a bag of block embeddings is frequently **block type**
 * rather than subject. A split along that seam is not "this is two skills", it is "this skill
 * has rules and steps", which is true of nearly every good skill in the corpus.
 *
 * `typeAlignment` measures it, and a split that the block types explain is reported as
 * `type-aligned` and never as a decomposition proposal. This is the `quality_score` banding
 * mistake seen coming: a confident number measuring the wrong thing, in a place where acting on
 * it means telling somebody to cut their document in half.
 */

/* ------------------------------------------------------------------ vectors */

/** Cosine similarity of two equal-length vectors. Returns 0 when either has no magnitude. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The mean of a set of vectors. The document's own centre, for RW.11's centrality test. */
export function centroid(vectors: ReadonlyArray<readonly number[]>): number[] {
  const width = vectors[0]?.length ?? 0;
  const sum = new Array<number>(width).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) sum[i] += vector[i];
  }
  return sum.map((value) => value / Math.max(1, vectors.length));
}

/* ------------------------------------------------------ RW.10 scope analysis */

/**
 * Blocks below this are not enough document to judge.
 *
 * A five-block skill that reads as two topics is a short skill, not two skills, and proposing a
 * decomposition of it would be the loudest possible way to be wrong about the smallest possible
 * document. Reported as `not-measurable`, never as `cohesive` — those are different sentences
 * and collapsing them is the mistake `archetypes --blocks` made with eleven rows of zeros.
 */
export const MIN_BLOCKS_TO_JUDGE = 12;

/** Neither half of a proposed split may be smaller than this. */
export const MIN_CLUSTER_BLOCKS = 4;

/**
 * How far apart the two halves must sit before a split is worth raising.
 *
 * Separation is `1 − cosine(centroidA, centroidB)`, so 0 is "the same topic twice" and 1 is
 * "nothing in common".
 *
 * **Measured, at analyser 1.1.0.** The first value was 0.22, guessed from A6 summary distances,
 * and the first corpus run returned **51% split candidates** — a seam that is everywhere is not a
 * seam. `pnpm scope --calibrate` gave the number two reference points it had never had:
 *
 * | population | p10 | p50 | p90 | max |
 * |---|---|---|---|---|
 * | one real corpus document | 0.186 | 0.346 | 0.456 | 0.483 |
 * | two unrelated skills, glued together | 0.332 | **0.474** | 0.675 | 0.722 |
 *
 * The two separate: a real document's p90 sits *below* the glued median, and only **4%** of real
 * documents reach it. So the threshold is the glued median — a document scoring above it is at
 * least as separated as half of all documents that genuinely are two skills.
 *
 * **The recall cost is real and is the chosen direction.** At 0.474 this misses roughly half of
 * true two-subject documents: everything below the glued median. That is deliberate, because the
 * two errors are not symmetric — a missed split is invisible, and a false one asks an author to
 * cut up a document that was fine. RW.10 finds the clearest cases, not all of them, and every
 * surface says so rather than implying a clean sweep.
 *
 * Thin evidence, stated: n=28 single documents and n=17 pairs. Worth re-running larger before
 * anything leans on it harder than a CLI does.
 */
export const MIN_SPLIT_SEPARATION = 0.474;

/**
 * Above this, the split is explained by block type and is not a scope finding.
 *
 * Purity is the share of each cluster taken by its own commonest block type, averaged. Two
 * clusters that are each 75% one type — and different types — have separated *guardrails from
 * procedures*, which every well-formed skill has. See the module comment: this is the whole
 * reason the analyser can be trusted to say "two skills" at all.
 *
 * **Measured limitation: the guard cannot run on 86% of real documents.** 58% of corpus blocks
 * carry no type, so on most skills at least one cluster is mostly unclassified and
 * `typeAlignment` correctly returns null rather than counting an absent label as a type. On
 * those, separation is judged alone. The guard is right where it applies and covers about one
 * document in seven — which is worth stating plainly rather than leaving as an assumption that
 * the confound is handled everywhere.
 */
export const MAX_TYPE_PURITY = 0.7;

export const SCOPE_VERDICTS = ["cohesive", "split-candidate", "type-aligned", "not-measurable"] as const;

export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

export const SCOPE_VERDICT_META: Record<ScopeVerdict, { label: string; blurb: string }> = {
  cohesive: {
    label: "One subject",
    blurb: "The blocks sit close together. Nothing suggests this is more than one skill.",
  },
  "split-candidate": {
    label: "Possibly two skills",
    blurb:
      "The blocks fall into two groups at least as far apart as half of all genuinely two-subject documents, and block type does not explain the gap. Worth reading as two. The reverse does not hold: a cohesive verdict is not a guarantee of one subject, because the threshold is set to miss rather than to accuse.",
  },
  "type-aligned": {
    label: "Split explained by block type",
    blurb:
      "The two groups are mostly rules against mostly steps, which nearly every good skill has. Not a scope finding.",
  },
  "not-measurable": {
    label: "Too few blocks to judge",
    blurb: "A short document that reads as two topics is a short document.",
  },
};

export type ScopeInput = {
  /** One per block, in document order. */
  vectors: ReadonlyArray<readonly number[]>;
  /** The block's type, or null when the extractor did not classify it. Same order. */
  types: ReadonlyArray<string | null>;
};

export type ScopeReport = {
  verdict: ScopeVerdict;
  blocks: number;
  /** Mean pairwise cosine over every block. High is one subject. */
  cohesion: number;
  /** `1 − cosine` between the two cluster centres. Null when there was nothing to split. */
  separation: number | null;
  /** Mean per-cluster purity by block type. Null when there was nothing to split. */
  typePurity: number | null;
  /** Indices of the blocks in each half, in document order. Empty when not split. */
  clusters: [number[], number[]];
};

/**
 * Mean pairwise cosine. The document's own tightness, independent of any split.
 *
 * Reported alongside the verdict rather than instead of it, because the two answer different
 * questions: cohesion says how varied the document is, and separation says whether that
 * variation has a seam in it. A rambling one-subject skill and a tidy two-subject skill can
 * share a cohesion score and need opposite advice.
 */
export function meanPairwiseCosine(vectors: ReadonlyArray<readonly number[]>): number {
  if (vectors.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      total += cosine(vectors[i], vectors[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

/**
 * Two-means, seeded deterministically from the furthest-apart pair.
 *
 * **Random initialisation is not acceptable here.** A scope verdict is stored, shown to an
 * author and re-derivable for R7.2, and k-means from a random seed gives a different answer on
 * a re-run of the same document — so "is this two skills" would depend on when you asked. The
 * two most dissimilar blocks are a defensible and reproducible pair of seeds, and on a document
 * that genuinely has two subjects they are almost always one from each.
 *
 * Ten iterations is plenty at this size; it converges in two or three on real documents and the
 * cap only exists so a pathological input cannot spin.
 */
export function splitInTwo(vectors: ReadonlyArray<readonly number[]>): [number[], number[]] {
  if (vectors.length < 2) return [vectors.map((_, i) => i), []];

  let seedA = 0;
  let seedB = 1;
  let worst = Infinity;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const similarity = cosine(vectors[i], vectors[j]);
      if (similarity < worst) {
        worst = similarity;
        seedA = i;
        seedB = j;
      }
    }
  }

  let centreA = [...vectors[seedA]];
  let centreB = [...vectors[seedB]];
  let a: number[] = [];
  let b: number[] = [];

  for (let round = 0; round < 10; round += 1) {
    a = [];
    b = [];
    for (let i = 0; i < vectors.length; i += 1) {
      (cosine(vectors[i], centreA) >= cosine(vectors[i], centreB) ? a : b).push(i);
    }
    if (a.length === 0 || b.length === 0) break;
    const nextA = centroid(a.map((i) => vectors[i]));
    const nextB = centroid(b.map((i) => vectors[i]));
    const settled = cosine(nextA, centreA) > 0.9999 && cosine(nextB, centreB) > 0.9999;
    centreA = nextA;
    centreB = nextB;
    if (settled) break;
  }

  return [a, b];
}

/**
 * How much of the split the block types explain.
 *
 * Mean of each cluster's dominant-type share, and **null when either side is mostly
 * unclassified** — 58% of corpus blocks carry no type, and calling a split "explained by type"
 * on the strength of an absent label would refuse real findings for no reason. Unclassified is
 * not a type; it is the absence of one, and the two must not be counted together.
 */
export function typeAlignment(
  types: ReadonlyArray<string | null>,
  clusters: readonly [number[], number[]],
): number | null {
  const shares: number[] = [];
  for (const cluster of clusters) {
    const typed = cluster.map((i) => types[i]).filter((t): t is string => t !== null);
    if (typed.length < cluster.length / 2) return null;
    const counts = new Map<string, number>();
    for (const type of typed) counts.set(type, (counts.get(type) ?? 0) + 1);
    shares.push(Math.max(...counts.values()) / typed.length);
  }
  return shares.reduce((sum, share) => sum + share, 0) / shares.length;
}

/** The whole RW.10 decision, as one pure function over vectors and types. */
export function analyseCohesion(input: ScopeInput): ScopeReport {
  const { vectors, types } = input;
  const blocks = vectors.length;
  const cohesion = meanPairwiseCosine(vectors);

  if (blocks < MIN_BLOCKS_TO_JUDGE) {
    return {
      verdict: "not-measurable",
      blocks,
      cohesion,
      separation: null,
      typePurity: null,
      clusters: [[], []],
    };
  }

  const clusters = splitInTwo(vectors);
  const [a, b] = clusters;

  if (a.length < MIN_CLUSTER_BLOCKS || b.length < MIN_CLUSTER_BLOCKS) {
    /*
     * A lopsided split is one odd passage, not a second skill. Reported as cohesive rather
     * than as a weak split: an author told "this might be two skills, one of which is three
     * paragraphs" would rightly stop reading the panel.
     */
    return { verdict: "cohesive", blocks, cohesion, separation: null, typePurity: null, clusters: [[], []] };
  }

  const separation = 1 - cosine(centroid(a.map((i) => vectors[i])), centroid(b.map((i) => vectors[i])));
  const typePurity = typeAlignment(types, clusters);

  if (separation < MIN_SPLIT_SEPARATION) {
    return { verdict: "cohesive", blocks, cohesion, separation, typePurity, clusters };
  }
  if (typePurity !== null && typePurity > MAX_TYPE_PURITY) {
    return { verdict: "type-aligned", blocks, cohesion, separation, typePurity, clusters };
  }
  return { verdict: "split-candidate", blocks, cohesion, separation, typePurity, clusters };
}

/* --------------------------------------------- RW.11 disclosure restructuring */

/**
 * A block has to be worth moving.
 *
 * Below this it is cheaper to leave it than to make the reader follow a pointer, and a
 * `references/` directory of one-paragraph files is worse than a slightly longer document.
 */
export const DISCLOSURE_MIN_WORDS = 60;

/**
 * And it has to be peripheral.
 *
 * Cosine to the document's own centre. A long block that sits at the heart of the subject is
 * the skill; a long block off to one side is the appendix. Moving the first one out would
 * hollow out the document while reporting a token saving, which is exactly the shape of D4's
 * "saving-only rule is a document shredder" failure, one level down.
 */
export const DISCLOSURE_MAX_CENTRALITY = 0.55;

/**
 * Types that are never proposed for offloading, whatever their length or position.
 *
 * A trigger is what makes the skill fire and a guardrail is an unconditional rule — both have
 * to be in the body, because an agent that has to follow a pointer to discover a prohibition
 * has already had the chance to break it. The miner rewards *offloading detail*, not offloading
 * the parts that do the work.
 */
export const NEVER_OFFLOAD: readonly string[] = ["trigger", "guardrail", "stance", "tool-contract"];

export type DisclosureCandidate = {
  /** Index into the analysed block list. */
  index: number;
  words: number;
  tokens: number;
  centrality: number;
  type: string | null;
};

export type DisclosureReport = {
  /** True when the body is over the validator's own disclosure hint and this is worth doing. */
  oversized: boolean;
  bodyBytes: number;
  candidates: DisclosureCandidate[];
  /** Estimated activation tokens returned to the reader if every candidate moved out. */
  movableTokens: number;
};

export type DisclosureInput = {
  vectors: ReadonlyArray<readonly number[]>;
  types: ReadonlyArray<string | null>;
  words: readonly number[];
  tokens: readonly number[];
  bodyBytes: number;
  /** From `src/lib/tokens.ts` — the validator's own threshold, never a second one. */
  hintBytes: number;
};

/**
 * Which blocks could move to `references/`, and what that would return.
 *
 * **Only proposed for a document the validator already considers large.** Below the hint size
 * there is nothing to fix, and a restructurer that fires on every skill is a linter nobody
 * leaves switched on. The threshold is imported rather than chosen, for the reason A3 gives:
 * a cost display with its own idea of "too big" eventually tells an author their skill is fine
 * while the validator flags it as an oversized monolith.
 */
export function analyseDisclosure(input: DisclosureInput): DisclosureReport {
  const oversized = input.bodyBytes > input.hintBytes;
  if (!oversized || input.vectors.length === 0) {
    return { oversized, bodyBytes: input.bodyBytes, candidates: [], movableTokens: 0 };
  }

  const centre = centroid(input.vectors);
  const candidates: DisclosureCandidate[] = [];
  for (let i = 0; i < input.vectors.length; i += 1) {
    const type = input.types[i];
    if (type !== null && NEVER_OFFLOAD.includes(type)) continue;
    if (input.words[i] < DISCLOSURE_MIN_WORDS) continue;
    const centrality = cosine(input.vectors[i], centre);
    if (centrality > DISCLOSURE_MAX_CENTRALITY) continue;
    candidates.push({ index: i, words: input.words[i], tokens: input.tokens[i], centrality, type });
  }

  /* Furthest from the centre first: the least missed, moved first. */
  candidates.sort((a, b) => a.centrality - b.centrality);

  return {
    oversized,
    bodyBytes: input.bodyBytes,
    candidates,
    movableTokens: candidates.reduce((sum, candidate) => sum + candidate.tokens, 0),
  };
}

/**
 * Bumped when the analyser would decide differently.
 *
 * The re-run selector and R7.2's reproducibility, exactly as `EXTRACTOR_VERSION` and
 * `MINER_VERSION` are. A stored verdict says which rules produced it, so a threshold change
 * does not quietly re-label a corpus that was never re-measured.
 *
 * **1.1.0** moved `MIN_SPLIT_SEPARATION` from a guessed 0.22 to a measured 0.474, which changes
 * the verdict on most of the corpus. The 122 rows written at 1.0.0 are stale by construction and
 * the selector picks them all up again — nothing to clean, which is the property having the
 * version in the unique key buys.
 */
export const SCOPE_ANALYSER_VERSION = "1.1.0";
