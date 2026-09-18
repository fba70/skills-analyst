/**
 * What this deployment tells a reader when it will not call a model.
 *
 * A leaf module with no imports, for the seventh time and the same reason as `plans.ts`,
 * `quality.ts` and `models.ts`: the refusal is thrown from `server-only` code and the notice
 * is rendered by client components, so the sentence has to live somewhere both can reach.
 *
 * One sentence, in one place, because the two halves would otherwise disagree — and the way
 * they disagree matters here. A page that says "AI is off" beside an enabled button, or a
 * refusal that reads like an outage, both tell the reader the deployment is broken when it is
 * doing exactly what it was configured to do.
 *
 * The switch itself is `LLM_ENABLED` in `server/billing/spend.ts`. It is deliberately **not**
 * re-exported through here: a flag readable from a client component would need a
 * `NEXT_PUBLIC_` copy, and a second copy of a kill switch is a kill switch that can be wrong.
 */

/** The fact. Short enough to be a heading. */
export const LLM_OFF_HEADLINE = "AI features are switched off on this deployment.";

/**
 * What still works, which is most of it.
 *
 * Written as a list of what a reader *can* do rather than what they cannot, because the
 * accurate reading is that the platform is running and one class of feature is switched off
 * — not that the account is limited or the service is degraded.
 */
export const LLM_OFF_DETAIL =
  "You can still browse, search and download the registry, write and edit skills by hand, " +
  "validate them and publish them. Anything that calls a language model — generation, " +
  "interview, distill, evals and similarity — is unavailable for now.";
