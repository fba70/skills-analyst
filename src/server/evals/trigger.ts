import "server-only";

import {
  COLLISION_NEIGHBOURS,
  isThin,
  precision,
  recall,
  type Collision,
  type ConfusionCounts,
  type TriggerReport,
} from "@/lib/trigger";
import { embedBatch } from "@/server/analytics/embeddings";
import {
  embeddingSummary,
  nearestToVector,
  RELIABLE_COVERAGE,
} from "@/server/analytics/embeddings-run";

import { contentHashOf, evalStates, type EvalParent } from "./store";

/**
 * The trigger-precision lab (Doc 6 RW.8, Doc 2 R2.8, plan step D2).
 *
 * ## It owns no probes, and that was the point of building D1 first
 *
 * An earlier ordering had this step independent of Skill CI, which would have produced a second
 * probe table — and should-trigger cases and trigger probes are the same concept at different
 * aggregation levels. Everything here reads `skill_evals` and `eval_runs`. There is nothing to
 * keep in step, because there is nothing else to be in step with.
 *
 * ## The quick check spends nothing
 *
 * Precision and recall are arithmetic over run rows that already exist. No model, no vectors,
 * no charge — which is why they are free rather than because a line was drawn to sell the rest.
 * The collision half embeds every probe, so it is the part that costs and the part that is Pro.
 *
 * ## Two proxies, kept apart
 *
 * Precision and recall judge the **description as written**: would a reader of that sentence
 * reach for this skill. Collision is a **retrieval** signal: of everything in the corpus, does
 * this request land nearer to something else. They disagree usefully — a description can be
 * perfectly clear and still lose every request to a better-known neighbour — and averaging them
 * would produce a number nobody could act on.
 *
 * Both are proxies for what a real agent does with a real library, and neither is that. Said
 * plainly here and on the panel, because the failure mode of this lab is a confident number.
 */

export type TriggerLabInput = EvalParent & {
  orgId: string;
  name: string;
  description: string;
  /** Only to compute the current hash: a stale run must not count towards a rate. */
  body: string;
  /** Off by default. The collision half is the metered one. */
  includeCollisions?: boolean;
  /** Excluded from its own neighbour list once a draft has been published. */
  excludeSkillId?: string;
};

export async function triggerReport(input: TriggerLabInput): Promise<TriggerReport> {
  const parent: EvalParent =
    "draftId" in input ? { draftId: input.draftId } : { skillId: input.skillId };
  const states = await evalStates(parent, input.orgId);
  const hash = contentHashOf(input.body);

  const probes = states.filter(
    (state) => state.kind === "should-trigger" || state.kind === "should-not-trigger",
  );

  /*
   * Only runs that describe *this* document count towards a rate.
   *
   * A precision figure mixing verdicts from three different drafts is a number about no
   * document at all. Excluded probes are reported separately rather than folded in — "we have
   * not measured this" and "this failed" are the distinction the eval panel already keeps, and
   * a rate is exactly where collapsing them would be invisible.
   */
  const current = probes.filter((state) => state.latest?.contentHash === hash);
  const staleProbes = probes.filter(
    (state) => state.latest !== null && state.latest.contentHash !== hash,
  ).length;
  const unrunProbes = probes.filter((state) => state.latest === null).length;

  const counts: ConfusionCounts = {
    truePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
    falsePositive: 0,
  };

  for (const state of current) {
    /*
     * An `error` verdict is dropped entirely. A refused call is a fact about us, and letting it
     * land in either column would move a rate the author is being asked to act on.
     */
    if (state.latest?.verdict === "error") continue;
    const passed = state.latest?.verdict === "pass";
    if (state.kind === "should-trigger") {
      if (passed) counts.truePositive += 1;
      else counts.falseNegative += 1;
    } else {
      if (passed) counts.trueNegative += 1;
      else counts.falsePositive += 1;
    }
  }

  const { totals, eligible } = await embeddingSummary();
  const coveragePercent = eligible > 0 ? Math.round((totals.embedded / eligible) * 100) : 0;

  const report: TriggerReport = {
    counts,
    recall: recall(counts),
    precision: precision(counts),
    thin: isThin(counts),
    staleProbes,
    unrunProbes,
    collisions: null,
    coveragePercent,
    coverageReliable: coveragePercent >= RELIABLE_COVERAGE,
  };

  if (!input.includeCollisions) return report;

  report.collisions = await collisionsFor(
    probes.filter((state) => state.kind === "should-trigger").map((state) => state.prompt),
    input,
    totals.embedded,
  );
  return report;
}

/**
 * Which requests land nearer to somebody else's skill than to this one.
 *
 * ## One batch, and the description rides along in it
 *
 * The description and every probe go to `embedBatch` together. Two reasons: one call is cheaper
 * than N+1, and — the one that matters — the description and the probes are then embedded by
 * the same model at the same moment. Comparing a vector made now against one made in a previous
 * call would be comparing across a model change that nothing would have noticed.
 *
 * ## Cosine computed here, neighbours computed in Postgres
 *
 * The skill being tested is usually a **draft**, which has no row in `skill_embeddings` — there
 * is nothing to run a `<=>` against. So its similarity to each probe is computed in JS from the
 * two vectors, while the corpus neighbours come from the index, and both are cosine over the
 * same embedder. Normalisation is not assumed: `text-embedding-3-small` returns unit vectors
 * today, and a dot product that silently stopped being cosine would shift every number here
 * with nothing failing.
 */
async function collisionsFor(
  prompts: string[],
  input: TriggerLabInput,
  embeddedCount: number,
): Promise<Collision[]> {
  if (prompts.length === 0) return [];
  /*
   * No index, no answer, and no charge. Embedding the probes to compare them against an empty
   * corpus would bill for a question that cannot be answered — the guard `similarToText`
   * already makes for the same reason.
   */
  if (embeddedCount === 0) return [];

  const { vectors } = await embedBatch(
    [`${input.name}\n${input.description}`, ...prompts],
    /*
     * The customer's budget, not the platform's. A Pro workspace pressing this once per probe
     * would otherwise eat the corpus-analysis allowance — the failure RC.2 keeps two budgets to
     * prevent, and the one B3's similarity check had been quietly causing since it shipped.
     */
    { purpose: "eval", orgId: input.orgId },
  );
  if (vectors.length !== prompts.length + 1) return [];

  const own = vectors[0];
  const collisions: Collision[] = [];

  for (let i = 0; i < prompts.length; i += 1) {
    const probe = vectors[i + 1];
    /*
     * Rounded before the comparison, not after it.
     *
     * `nearestToVector` rounds to three places; this side did not, so a neighbour whose raw
     * score sat a ten-thousandth above the skill's was filtered in and then rendered at the
     * *same* three-place number — a panel reading "this skill 0.702 · nearer: X 0.702", which
     * looks like a bug because it is one. Found by running the thing rather than by reading it.
     *
     * Rounding both sides also makes the tie rule mean what its comment says: a neighbour level
     * with this skill at the precision anybody can see is not winning.
     */
    const ownSimilarity = round(cosine(own, probe));
    const neighbours = await nearestToVector(probe, COLLISION_NEIGHBOURS, input.excludeSkillId);

    collisions.push({
      prompt: prompts[i],
      own: ownSimilarity,
      /*
       * Strictly nearer. Reporting a tie as a collision would make every probe contested in a
       * category where the corpus is dense — which is most of them.
       */
      nearer: neighbours
        .filter((hit) => hit.similarity > ownSimilarity)
        .map((hit) => ({ slug: hit.slug, name: hit.name, similarity: hit.similarity })),
    });
  }

  return collisions;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Three places, matching what `nearestToVector` rounds to, so the two sides compare. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
