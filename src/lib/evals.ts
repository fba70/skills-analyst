/**
 * Skill CI: the eval vocabulary (Doc 2 R2.11, Doc 6 RW.6, plan step D1).
 *
 * ## What this makes true
 *
 * Everything the platform says about quality today is a statement about *form*. The analyzers
 * check that a skill is well-formed, the archetype says its shape matches what the corpus
 * rewards, the quality score adds those up. None of it says the skill **works**.
 *
 * An eval says that, and it is the difference between a registry and a product: a paid tier
 * built on "our validator likes it" is a paid tier built on our opinion.
 *
 * ## One probe model, not two
 *
 * The plan is explicit about this and it is the decision worth protecting. An earlier ordering
 * had a trigger-precision lab (RW.8) independent of Skill CI, which would have produced two
 * probe tables — and should-trigger cases and trigger probes are **the same concept at
 * different aggregation levels**. D1 owns the model; D2 is analysis over it. Two tables would
 * have meant two places to write a probe and two answers to "does this skill fire correctly".
 *
 * So the three kinds live in one vocabulary, and the trigger lab reads the same rows the CI
 * run wrote.
 */

export const EVAL_KINDS = ["should-trigger", "should-not-trigger", "golden-task"] as const;

export type EvalKind = (typeof EVAL_KINDS)[number];

export function isEvalKind(value: unknown): value is EvalKind {
  return typeof value === "string" && (EVAL_KINDS as readonly string[]).includes(value);
}

export const EVAL_KIND_META: Record<
  EvalKind,
  { label: string; blurb: string; needsExpectation: boolean }
> = {
  "should-trigger": {
    label: "Should fire",
    blurb:
      "A request an agent should reach for this skill on. Recall: the skill is useless if it never fires.",
    needsExpectation: false,
  },
  "should-not-trigger": {
    label: "Should not fire",
    blurb:
      "A nearby request this skill should stay out of. Precision: a skill that fires on everything is noise in every conversation.",
    needsExpectation: false,
  },
  "golden-task": {
    label: "Golden task",
    blurb:
      "A real input and what makes the right answer right. The only case that tests the body rather than the description.",
    needsExpectation: true,
  },
};

/**
 * `error` is not `fail`, and keeping them apart is the whole reason there are three.
 *
 * A failed case is a fact about the skill. An errored case is a fact about us — a refused call,
 * a budget refusal, an unparseable answer — and counting one as the other would let an outage
 * read as a quality regression and block a publish that had nothing wrong with it.
 */
export const EVAL_VERDICTS = ["pass", "fail", "error"] as const;

export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

export function isEvalVerdict(value: unknown): value is EvalVerdict {
  return typeof value === "string" && (EVAL_VERDICTS as readonly string[]).includes(value);
}

/** Where a case came from. `interview` is a worked example an author captured (RW.4). */
export const EVAL_SOURCES = ["authored", "interview"] as const;

export type EvalSource = (typeof EVAL_SOURCES)[number];

export type EvalCaseState = {
  id: string;
  kind: EvalKind;
  prompt: string;
  expectation: string | null;
  source: EvalSource;
  /** The newest run, or null when the case has never been run. */
  latest: { verdict: EvalVerdict; detail: string | null; contentHash: string } | null;
  /** The newest run against a *different*, earlier document. Null when there is none. */
  previous: { verdict: EvalVerdict; contentHash: string } | null;
};

/**
 * Whether a case's newest run describes the document as it stands.
 *
 * Staleness rather than auto-running is the deviation from the plan worth naming. The plan says
 * "every edit re-runs", and taken literally that bills a model call for every save in a block
 * editing session — the shape `findSimilarAction` already refused when it made similarity a
 * button rather than an autocomplete.
 *
 * What "every edit re-runs" is *for* is that a result must never describe an older document.
 * Stamping each run with the body's content hash gets that property exactly, costs nothing, and
 * is stronger: a stale result is visibly stale rather than being silently replaced by a fresh
 * run the author did not ask for.
 */
export function isStale(state: EvalCaseState, contentHash: string): boolean {
  return state.latest === null || state.latest.contentHash !== contentHash;
}

/**
 * A regression: this case passed against an earlier document and fails against this one.
 *
 * **This is what blocks a publish, and "any failure" is not.** An author who writes an
 * aspirational case — the thing the skill does not do yet — must still be able to publish the
 * skill; that case has never passed and failing is its correct state. A case that *was* passing
 * and now is not is a different claim entirely: something the skill used to do, it no longer
 * does.
 *
 * `error` on either side is not a regression. A refused call says nothing about the skill.
 */
export function isRegression(state: EvalCaseState): boolean {
  return (
    state.latest?.verdict === "fail" &&
    state.previous?.verdict === "pass" &&
    state.latest.contentHash !== state.previous.contentHash
  );
}

export type EvalSummary = {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  neverRun: number;
  stale: number;
  regressions: number;
};

export function summarise(cases: EvalCaseState[], contentHash: string): EvalSummary {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.latest?.verdict === "pass").length,
    failed: cases.filter((c) => c.latest?.verdict === "fail").length,
    errored: cases.filter((c) => c.latest?.verdict === "error").length,
    neverRun: cases.filter((c) => c.latest === null).length,
    stale: cases.filter((c) => isStale(c, contentHash)).length,
    regressions: cases.filter(isRegression).length,
  };
}

/**
 * How many cases one run may cover.
 *
 * A bound on a metered loop, in the same spirit as `MAX_BATCH` in the classifier: a fuse rather
 * than a setting. Trigger probes are cheap and golden tasks are not, so the cap is on cases
 * rather than on money — the budget is what bounds money, and it already does.
 */
export const MAX_CASES_PER_RUN = 25;

/** Bounds on what an author may write, stated rather than discovered from a failure. */
export const MAX_PROMPT_CHARS = 4_000;
export const MAX_EXPECTATION_CHARS = 4_000;
