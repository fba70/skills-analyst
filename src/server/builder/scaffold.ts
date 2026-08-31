import "server-only";

import { sectionRoleBlurb, sectionRoleLabel } from "@/lib/section-roles";
import { archetypeDetail, type ArchetypeDetail } from "@/server/analytics/archetype-read";
import type { SkillRef } from "@/server/dal/skills";
import { FUNCTIONS } from "@/server/taxonomy/vocabulary";

/**
 * Turning a mined archetype into something an author fills in (Doc 2 R4.1).
 *
 * This is the load-bearing half of the builder. A wizard that asks "what sections do you
 * want?" is a blank page with extra steps; the point of R4.1 is that the corpus already
 * knows what a good skill in this category looks like, so the form should be *that shape*
 * before the author types anything.
 *
 * ## Every prompt carries its evidence
 *
 * R5.2's acceptance criterion is explicit: a suggestion must be traceable to the archetype
 * element or exemplar it came from, and the assistant "never asserts a corpus fact without
 * a retrievable source". So a section is not just a heading — it carries the prevalence in
 * each band, the lift that earned it a place, and how many structures were behind the
 * archetype. The UI shows that beside the field, which is the difference between "add a
 * troubleshooting section" and "28% of curated skills here have one against 5% of the rest".
 *
 * ## A category with no archetype still works
 *
 * One function category has not cleared the evidence gate, and more will not while the
 * corpus grows. Refusing to scaffold would make the builder unavailable for exactly the
 * categories where an author has least to copy from. The fallback is a plain skeleton
 * marked as such — honest about having no evidence rather than inventing some.
 */

export type ScaffoldSection = {
  role: string;
  label: string;
  /** What goes in it, in general. */
  blurb: string;
  /** Present in this share of curated skills in the category. Null without an archetype. */
  strongPrevalence: number | null;
  weakPrevalence: number | null;
  lift: number | null;
  /** Present in nearly every curated example — treat as expected rather than optional. */
  required: boolean;
};

export type ScaffoldTrait = {
  label: string;
  strongPrevalence: number;
  weakPrevalence: number;
  lift: number;
};

export type Scaffold = {
  category: string;
  categoryLabel: string;
  categoryDescription: string;
  /** Null when nothing has been mined for this category yet. */
  archetypeVersion: number | null;
  /** The evidence line, so the form can say where its shape came from (R3.4, R5.2). */
  evidence: { structures: number; sources: number; skills: number } | null;
  sections: ScaffoldSection[];
  /** Conventions worth following, strongest first. */
  traits: ScaffoldTrait[];
  /** Choices that mark a skill out as weaker in this category. */
  antiPatterns: ScaffoldTrait[];
  norms: { medianWords: number; medianDescriptionLength: number; medianFileCount: number };
  /** Licence-clean skills the author can read before writing (R3.3). */
  exemplars: SkillRef[];
};

/**
 * The skeleton used when a category has no mined archetype.
 *
 * Not a guess dressed as evidence: these four are the roles that appear in essentially
 * every skill dialect's own documentation, and the scaffold reports `lift: null` for them
 * so nothing downstream can present them as a corpus finding.
 */
const FALLBACK_ROLES = ["purpose", "when-to-use", "steps", "examples"] as const;

export async function buildScaffold(category: string): Promise<Scaffold | null> {
  const fn = FUNCTIONS.find((f) => f.id === category);
  if (!fn) return null;

  const archetype = await archetypeDetail(category);

  return {
    category,
    categoryLabel: fn.label,
    categoryDescription: fn.description,
    archetypeVersion: archetype?.version ?? null,
    evidence: archetype
      ? {
          structures: archetype.distinctStructures,
          sources: archetype.sourceCount,
          skills: archetype.skillCount,
        }
      : null,
    sections: archetype ? sectionsFrom(archetype) : fallbackSections(),
    traits: archetype?.skeleton.traits ?? [],
    antiPatterns: archetype?.antiPatterns ?? [],
    norms: archetype?.skeleton.norms ?? {
      medianWords: 0,
      medianDescriptionLength: 0,
      medianFileCount: 1,
    },
    exemplars: archetype?.exemplars ?? [],
  };
}

/**
 * Archetype sections, plus the ones every skill needs regardless.
 *
 * A mined skeleton is a *contrast* — it lists what separates good skills from weak ones,
 * which is deliberately not the same as what a skill must contain. `purpose` has near-zero
 * lift in most categories precisely because everybody writes one, and a form built only
 * from the archetype would therefore never ask what the skill is for.
 *
 * So the two are merged: mined sections keep their evidence, and the always-needed ones are
 * added with `lift: null` so the UI can tell them apart and never claim corpus support for
 * something the corpus did not say.
 */
function sectionsFrom(archetype: ArchetypeDetail): ScaffoldSection[] {
  const mined = archetype.skeleton.sections.map((section) => ({
    role: section.role,
    label: sectionRoleLabel(section.role),
    blurb: sectionRoleBlurb(section.role),
    strongPrevalence: section.strongPrevalence,
    weakPrevalence: section.weakPrevalence,
    lift: section.lift,
    required: section.required,
  }));

  const present = new Set(mined.map((section) => section.role));
  const essential = (["purpose", "when-to-use"] as const)
    .filter((role) => !present.has(role))
    .map((role) => ({
      role,
      label: sectionRoleLabel(role),
      blurb: sectionRoleBlurb(role),
      strongPrevalence: null,
      weakPrevalence: null,
      lift: null,
      required: role === "purpose",
    }));

  // Essentials first: they are what the document opens with, and the mined list is already
  // ordered by where each section typically sits.
  return [...essential, ...mined];
}

function fallbackSections(): ScaffoldSection[] {
  return FALLBACK_ROLES.map((role) => ({
    role,
    label: sectionRoleLabel(role),
    blurb: sectionRoleBlurb(role),
    strongPrevalence: null,
    weakPrevalence: null,
    lift: null,
    required: role === "purpose",
  }));
}

/** Function categories offered by the builder, with whether the corpus has anything to say. */
export async function builderCategories(): Promise<
  Array<{ id: string; label: string; description: string; hasArchetype: boolean }>
> {
  const { minedCategories } = await import("@/server/analytics/archetype-read");
  const mined = await minedCategories();
  return FUNCTIONS.map((fn) => ({
    id: fn.id,
    label: fn.label,
    description: fn.description,
    hasArchetype: mined.has(fn.id),
  }));
}
