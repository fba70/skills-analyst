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
export const MODEL_TASKS = ["taxonomy", "builder", "interview", "consistency"] as const;

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
  consistency: {
    label: "Description consistency (R2.3)",
    blurb:
      "Asks whether a skill's documentation honestly describes its bundled code. Opt-in, and only for bundles containing code.",
  },
};

export function isModelTask(value: unknown): value is ModelTask {
  return typeof value === "string" && (MODEL_TASKS as readonly string[]).includes(value);
}
