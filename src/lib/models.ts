/**
 * Which tasks have a configurable model, and what each one is for (Doc 2 RC.2).
 *
 * ## A leaf module, because the settings panel is a client component
 *
 * The read and write live in `src/server/settings/models.ts`, which is `server-only` — it
 * touches the database. The vocabulary cannot live there: the admin panel is a client
 * component, and importing a `server-only` module into one makes the build fail, correctly.
 *
 * This is the fifth time that split has been needed and the reason it is now a convention
 * rather than a discovery. `EXPORT_DIALECTS` moved to `lib/dialects.ts` for the export
 * checkbox list, `SEVERITY_WEIGHTS` and the badge bands moved to `lib/quality.ts` for the
 * FAQ, `capabilities.ts` and `section-roles.ts` the same way, and `block-types.ts` was born
 * here on purpose after `section-roles.ts` showed what duplicating a vocabulary costs.
 *
 * So: closed vocabulary here with no imports, database access in the server module, and
 * exactly one copy of each.
 */

/**
 * The tasks whose model is a setting.
 *
 * Keyed by task rather than by module, because the question an operator asks is "what is
 * classification costing me", not "what does `classify.ts` import".
 *
 * **Embeddings are deliberately absent.** The vector width is fixed in the column type and
 * in `EMBEDDER_VERSION`, so changing that model is a migration plus a full re-embed. A
 * control that cannot take effect is worse than no control — the same reason the rate-limit
 * panel states out loud that its paid row is stored and not in force.
 */
export const MODEL_TASKS = [
  "taxonomy",
  "builder",
  "interview",
  "evalAgent",
  "evalAgentB",
  "evalJudge",
  "consistency",
] as const;

export type ModelTask = (typeof MODEL_TASKS)[number];

export type ModelSettings = Record<ModelTask, string>;

/**
 * Defaults, which are the values that were hard-coded before the setting existed.
 *
 * Unchanged on purpose. Making a choice tunable is not the same as re-deciding it, and
 * bundling a behaviour change into a refactor loses the ability to attribute either one.
 */
export const MODEL_DEFAULTS: ModelSettings = {
  /** Bounded-choice labelling over tens of thousands of rows. Cheap wins outright. */
  taxonomy: "google/gemini-2.5-flash-lite",
  /** One call per authored skill, and the output *is* the product. */
  builder: "anthropic/claude-sonnet-5",
  /**
   * Interview mode (Doc 6 RW.4). The same model as authoring, and the same reasoning.
   *
   * A cheap model here fails in a way that is easy to miss and expensive to fix: an
   * interview's output is the *questions*, and a weak question elicits nothing an author
   * could not have typed into the form. There is no draft to inspect afterwards and see that
   * it went badly — there is only knowledge that was never captured.
   */
  interview: "anthropic/claude-sonnet-5",
  /**
   * The agent under test in a golden task (Doc 6 RW.6).
   *
   * It is standing in for a real agent following the skill, so it has to be the class of model
   * that would. A cheap one fails tasks because it is cheap, and the author reads that as the
   * skill being wrong — an eval that measures the runner rather than the subject is worse than
   * no eval, because it is confidently wrong.
   */
  evalAgent: "anthropic/claude-sonnet-5",
  /**
   * The second arm of the with/without matrix (Doc 6 RW.7).
   *
   * Deliberately a *smaller* model than the first. The interesting result is rarely "this helps
   * everything equally" — it is that a skill lifts a cheaper model towards a more capable one's
   * baseline, which is a real and saleable finding and one a single-model matrix reports
   * identically to no effect at all.
   */
  evalAgentB: "anthropic/claude-haiku-4.5",
  /**
   * The judge (Doc 6 RW.6).
   *
   * Bounded judgement over text that is all supplied — did this output meet this expectation,
   * should this request have fired this skill — which is the shape a small model does well and
   * the classifier already proves. It must not be the same call as the producer: a model
   * grading its own answer in one turn is not a judge.
   */
  evalJudge: "anthropic/claude-haiku-4.5",
  /** R2.3's documentation-versus-code audit, over the ~7% of bundles carrying code. */
  consistency: "anthropic/claude-haiku-4.5",
};

export const MODEL_TASK_META: Record<ModelTask, { label: string; blurb: string }> = {
  taxonomy: {
    label: "Classification",
    blurb:
      "Assigns function and domain categories. Tens of thousands of calls, bounded choice — the one task where the cheapest capable model is clearly right.",
  },
  builder: {
    label: "Skill authoring",
    blurb:
      "Writes a draft from the archetype and the author's notes. One call per skill, and the output is what the customer keeps.",
  },
  interview: {
    label: "Interview mode",
    blurb:
      "Asks the questions that elicit knowledge a form cannot. Many calls per skill, each carrying the transcript so far — the one task where the conversation cap matters more than the model choice.",
  },
  evalAgent: {
    label: "Eval — the agent under test",
    blurb:
      "Follows the skill on a golden task, so the output can be judged. Stands in for a real consumer, so it should be the class of model one would be.",
  },
  evalAgentB: {
    label: "Eval — the second arm",
    blurb:
      "The other model in the with/without matrix. Pairing a capable model with a cheaper one is what separates 'this skill helps' from 'this skill helps a small model'.",
  },
  evalJudge: {
    label: "Eval — the judge",
    blurb:
      "Decides whether an output met its expectation, and whether a request should have fired the skill. Bounded judgement over supplied text.",
  },
  consistency: {
    label: "Description consistency (R2.3)",
    blurb:
      "Asks whether a skill's documentation honestly describes its bundled code. Opt-in, and only for bundles containing code.",
  },
};

export function isModelTask(value: unknown): value is ModelTask {
  return typeof value === "string" && (MODEL_TASKS as readonly string[]).includes(value);
}
