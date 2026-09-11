import { foldName } from "@/lib/parameters";

/**
 * The decision surface: what a category's skills branch on (Doc 7 RD.5, plan step P7).
 *
 * ## The question this answers, and why nothing could answer it before
 *
 * `decision-rule` earns a place in **10 of 13 categories at median +21 lift** — the second
 * strongest block type in the corpus. So the archetype can tell an author *good review skills
 * carry decision rules and yours has none*, and cannot tell them what those rules are **about**.
 * P4 gave a draft its own parameters; this reads the same thing out of the corpus, so the
 * builder can say *curated review skills branch on change size, risk area and language* with two
 * band percentages behind each.
 *
 * ## Nothing here is free text a model emitted
 *
 * A model reading 23,476 documents will return `env`, `environment`, `target environment`,
 * `deployment environment` and `ENV` for one idea. Clustering folds them; a **curated label** is
 * what reaches a page. That is the taxonomy's own rule — the vocabulary is closed and reviewed,
 * and `pipeline_tag` rather than npm keywords — and it is why `DECISION_PARAMETERS` below starts
 * **empty**: the first sample has to be read by a person before a single label is written, the
 * way the tool vocabulary was written from a corpus count and the way three of the seed list's
 * hand-written entries turned out to be 404s.
 *
 * An empty vocabulary is therefore the honest state of this dimension today, and every surface
 * downstream must render it as *not measured yet* rather than as *no parameters found*.
 */

/**
 * What produced a stored extraction. In the unique key, so a prompt change cannot leave two
 * different readings of the corpus wearing one number — `classifier_version`'s lesson, and the
 * reason `SCOPE_ANALYSER_VERSION` moving to 1.1.0 handed 122 rows straight back to the selector.
 */
export const PARAMETER_ANALYSER_VERSION = "1.0.0";

/**
 * The composition behind a clustering vector.
 *
 * Its own constant rather than A6's `EMBEDDER_VERSION`, for the reason `BLOCK_EMBEDDER_VERSION`
 * is its own: the unit differs. A6 embeds a whole skill's claim; this embeds two or three words
 * naming one input. Sharing a version string would make two incomparable populations
 * indistinguishable in a column — and these vectors are not even stored, so the string exists to
 * label the *proposals* a run printed.
 */
export const PARAMETER_EMBEDDER_VERSION =
  "1.1.0:text-embedding-3-small:1536:parameter-name";

/** A parameter as the model read it out of one skill's decision rules. Untouched, unclustered. */
export type ExtractedParameter = {
  /** The author's own word for it, as it appeared. Folded only for comparison, never in storage. */
  name: string;
  /** `enum`, `number`, `boolean` or `free` — the same four kinds a draft declares. */
  kind: string;
  /** The values the rules branch between. Evidence for clustering; never shown to an author. */
  values: string[];
};

export type ExtractionRecord = {
  parameters: ExtractedParameter[];
  /** Decision-rule blocks read. Zero means the version carried none, which is not a failure. */
  blocksRead: number;
};

// ---------------------------------------------------------------------------------------
// The curated vocabulary
// ---------------------------------------------------------------------------------------

export type DecisionParameter = {
  id: string;
  label: string;
  blurb: string;
  /**
   * Folded names that resolve here. Written by a person reading the clusters, never by the
   * clusterer: a proposal is evidence that two words co-occur, and a decision that they mean one
   * thing is a judgement somebody has to make and be accountable for.
   */
  aliases: string[];
};

/**
 * **Deliberately empty.**
 *
 * Doc 7 RD.5 says the first 200 extractions must be read by a person before a cluster label is
 * curated, "or the surface describes the model's habits rather than the corpus's". Nothing has
 * been extracted yet, so there is nothing to read, so there are no labels. Writing a plausible
 * list here from what a parameter *usually* is called would be the written-from-memory failure
 * this programme exists to avoid, and it would be invisible: every downstream number would look
 * exactly as confident as a measured one.
 *
 * `pnpm parameters --clusters` prints the proposals to fill this from.
 */
export const DECISION_PARAMETERS: readonly DecisionParameter[] = [];

const BY_ALIAS: ReadonlyMap<string, string> = new Map(
  DECISION_PARAMETERS.flatMap((p) => [
    [foldName(p.label), p.id] as const,
    ...p.aliases.map((alias) => [foldName(alias), p.id] as const),
  ]),
);

/** The curated parameter a raw name belongs to, or null — which is the common answer today. */
export function resolveParameter(name: string): string | null {
  return BY_ALIAS.get(foldName(name)) ?? null;
}

export function parameterById(id: string): DecisionParameter | undefined {
  return DECISION_PARAMETERS.find((p) => p.id === id);
}

/**
 * Whether this dimension may be published at all.
 *
 * One condition, and it is about us rather than about the corpus: with no curated labels there is
 * nothing to put on a card but a model's raw output. Every reader of the mine asks this first and
 * prints *not measured* rather than an empty finding.
 */
export function vocabularyReady(): boolean {
  return DECISION_PARAMETERS.length > 0;
}

// ---------------------------------------------------------------------------------------
// Clustering — pure, so the maths is checkable with no corpus and no API key
// ---------------------------------------------------------------------------------------

/**
 * How close two parameter names must sit to be proposed as one.
 *
 * A guess, and the code says so — the same posture `MIN_SPLIT_SEPARATION` took at 0.22 before
 * `scope --calibrate` replaced it with a measured 0.474. The adjacent measurement is B3's: whole
 * skill summaries land 0.3–0.5 apart when they are genuinely different, and two short phrases
 * naming the same idea should sit far above that. **A proposal is read by a person either way**,
 * so the cost of it being wrong is a cluster somebody splits rather than a claim on a page.
 */
export const CLUSTER_SIMILARITY = 0.82;

/*
 * **The composition was measured and changed, and this is the record of it.**
 *
 * 1.0.0 embedded the name plus up to six observed values, reasoning that a bare two-word name
 * embeds thinly and that values are what separate `severity level` from `zoom level`. The first
 * real run refuted it: `file type` and `file types` — the same parameter, singular and plural —
 * landed at **0.531**, because one skill's values were `md, txt` and the other's were
 * `images, pdfs`, and on a two-word name the values dominate. A composition that cannot merge a
 * plural is not separating homonyms, it is separating everything.
 *
 * So 1.1.0 embeds the name alone. The values are still stored; they are evidence for a person
 * reading a cluster, not input to the vector. If homonyms turn out to be a real problem later,
 * the answer is a disambiguation pass on the few names that collide, not a composition that
 * pushes identical names apart.
 */

/** Cosine of two unit-length-agnostic vectors. Pure, and the only similarity in this module. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type ClusterInput = {
  /** The folded name. One entry per distinct name, never one per occurrence. */
  name: string;
  /** How many distinct repositories used it. The weight, for the same reason R3.4 counts sources. */
  sources: number;
  /** Occurrences, for the report only. */
  count: number;
  vector: number[];
};

export type ProposedCluster = {
  /** The most-sourced member, proposed as the label. A person renames it or splits the cluster. */
  proposedLabel: string;
  members: Array<{ name: string; sources: number; count: number }>;
  sources: number;
  count: number;
};

/**
 * Single-link agglomeration at a fixed threshold.
 *
 * Single-link rather than k-means for the reason C5's seeding is deterministic: a proposal that
 * changes between two runs of the same input is one nobody can review, and k-means from a random
 * seed does exactly that. The chaining single-link is criticised for is the right failure here —
 * `env` → `environment` → `deployment environment` is a chain and is also one parameter — and a
 * person reads every group before a label exists.
 *
 * Names are ordered by sources before grouping, so the proposed label is the most widely used
 * spelling rather than whichever row the database returned first.
 */
export function proposeClusters(
  items: readonly ClusterInput[],
  threshold = CLUSTER_SIMILARITY,
): ProposedCluster[] {
  const ordered = [...items].sort((a, b) => b.sources - a.sources || b.count - a.count);
  const parent = ordered.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (cosine(ordered[i].vector, ordered[j].vector) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, ProposedCluster>();
  for (let i = 0; i < ordered.length; i += 1) {
    const root = find(i);
    const item = ordered[i];
    const group = groups.get(root);
    if (group) {
      group.members.push({ name: item.name, sources: item.sources, count: item.count });
      group.sources += item.sources;
      group.count += item.count;
    } else {
      groups.set(root, {
        proposedLabel: item.name,
        members: [{ name: item.name, sources: item.sources, count: item.count }],
        sources: item.sources,
        count: item.count,
      });
    }
  }

  return [...groups.values()].sort((a, b) => b.sources - a.sources || b.count - a.count);
}

// ---------------------------------------------------------------------------------------
// What a mined parameter looks like once it clears the gate
// ---------------------------------------------------------------------------------------

/**
 * One row of the published dimension. The same shape a skeleton block has, minus density: a
 * parameter is present or it is not, and *how many times* a skill branches on one is a count
 * nobody has significance-tested — the line `stats.measuredBlocks` already holds about density.
 */
export type SkeletonParameter = {
  parameter: string;
  label: string;
  blurb: string;
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
};

export type MeasuredParameter = SkeletonParameter & {
  strongCount: number;
  weakCount: number;
  standardError: number;
  requiredLift: number;
  kept: boolean;
  rejectedFor: string | null;
};

// ---------------------------------------------------------------------------------------
// What a decision-rule block is — the free probe's vocabulary
// ---------------------------------------------------------------------------------------

/**
 * What a decision-rule block is, by rule alone.
 *
 * Four shapes, in the order the detector itself prefers structure over wording. Only the first
 * two can carry a parameter a model could name; the other two are the ones that would produce
 * confident noise, and knowing their share is what says whether the extraction is worth running.
 */
export const RULE_SHAPES = ["table", "conditional", "list", "prose"] as const;

export type RuleShape = (typeof RULE_SHAPES)[number];

export const RULE_SHAPE_META: Record<RuleShape, string> = {
  table: "A decision table. Columns are the parameters; a model has to name them, not find them.",
  conditional: "An if/when sentence. The shape RD.5 assumes, and the one a parameter falls out of.",
  list: "A bulleted list with no conditional. Usually a guardrail or a spec that read as a rule.",
  prose: "A paragraph that merely contains a conditional word. The noise floor for this dimension.",
};

/** Pure, so the probe's tally is reproducible and the suite can drive it with no corpus. */
export function shapeOf(text: string): RuleShape {
  const trimmed = text.trim();
  if (/^\s*\|.*\|/m.test(trimmed) && /\|\s*-{2,}/.test(trimmed)) return "table";
  /*
   * A bulleted list of arrows is a decision table without the pipes.
   *
   * Found by reading the probe's own output rather than by reasoning: *"Greenfield feature →
   * default EXPANSION · Bug fix → default HOLD SCOPE · Plan touching >15 files → suggest
   * REDUCTION"* is as parameterised as anything in the corpus, and the first version of this
   * function filed it under `list` — the shape whose whole meaning is *nothing to extract here*.
   * Counting it there understates the share this dimension can reach, which is the number the
   * decision to spend is made on.
   */
  if (/^\s*[-*]\s+.*(→|->|=>)/m.test(trimmed)) return "conditional";
  /*
   * A conditional at the start of a sentence, not anywhere in the passage. "If" inside the third
   * clause of a paragraph is what types expository prose as a decision rule, and counting that as
   * a conditional is exactly the over-claim this probe exists to measure.
   */
  if (/(^|[.!?]\s+|\n\s*[-*]?\s*)(if|when|unless|whenever)\b/i.test(trimmed)) return "conditional";
  if (/^\s*[-*]\s+/m.test(trimmed)) return "list";
  return "prose";
}
