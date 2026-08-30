/**
 * Section roles in words a skill author understands.
 *
 * A leaf module with no imports, for the same reason as `capabilities.ts`: the role slugs
 * are the extractor's vocabulary, not a reader's. `when-to-use` and `output-format` are
 * fine as database values and poor as headings on a page that is trying to teach someone
 * what to write.
 *
 * The blurb carries most of the weight. An archetype that says a skeleton needs a
 * `when-to-use` section has told an author the name of a box and nothing about what goes
 * in it; "the triggering contract — when an agent should reach for this, and when it
 * should not" is the sentence that makes the guidance actionable. These stay descriptive
 * rather than prescriptive, because the *prescription* is the mined lift beside them and
 * it changes as the corpus does.
 *
 * The keys mirror `SECTION_ROLES` in `src/server/analytics/structure.ts`, which is
 * `server-only` and cannot be imported from a page that may render on the client. A role
 * added there without a label here falls back to its de-slugged self rather than breaking
 * the page.
 */

export type SectionRoleMeta = {
  /** Sentence case, as it would appear as a heading. */
  label: string;
  /** One line: what an author actually puts under it. */
  blurb: string;
};

export const SECTION_ROLE_META: Record<string, SectionRoleMeta> = {
  purpose: {
    label: "Purpose",
    blurb: "What this skill is and what problem it solves.",
  },
  "when-to-use": {
    label: "When to use it",
    blurb:
      "The triggering contract — when an agent should reach for this skill, and when it should not.",
  },
  prerequisites: {
    label: "Prerequisites",
    blurb: "What must already be true, installed, or configured before it can run.",
  },
  "how-it-works": {
    label: "How it works",
    blurb: "The mechanism, conceptually — enough that a reader can predict its behaviour.",
  },
  steps: {
    label: "Steps",
    blurb: "The ordered procedure the agent follows.",
  },
  rules: {
    label: "Rules & constraints",
    blurb: "The musts and nevers: policies, limits, and the things that are not negotiable.",
  },
  examples: {
    label: "Examples",
    blurb: "Worked examples with real input and the output they produce.",
  },
  inputs: {
    label: "Inputs",
    blurb: "What has to be handed to the skill before it can start.",
  },
  "output-format": {
    label: "Output format",
    blurb: "The shape the answer must take, precisely enough to be checked.",
  },
  references: {
    label: "References",
    blurb: "Pointers to bundled files or external material, so the main document stays short.",
  },
  troubleshooting: {
    label: "Troubleshooting",
    blurb: "What to do when it goes wrong, and how to recognise which failure this is.",
  },
  limitations: {
    label: "Limitations",
    blurb: "Known bounds, non-goals, and the cases it is expected to handle badly.",
  },
  configuration: {
    label: "Configuration",
    blurb: "Options, settings and parameters, with their defaults.",
  },
  other: {
    label: "Topic sections",
    blurb: "Subject-matter headings the extractor recognised but did not classify.",
  },
};

/** Falls back to the de-slugged role rather than hiding one we have not labelled. */
export function sectionRoleLabel(role: string): string {
  return SECTION_ROLE_META[role]?.label ?? role.replace(/-/g, " ");
}

export function sectionRoleBlurb(role: string): string {
  return SECTION_ROLE_META[role]?.blurb ?? "A section the extractor recognised.";
}
