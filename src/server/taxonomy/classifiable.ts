import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { skills } from "@/server/db/schema";

/**
 * Which skills can be categorised at all (R3.1).
 *
 * The classifier sees a name and a description. When there is no description, and the name
 * is a directory the normalizer fell back to — `demo`, `root`, `s`, `input-repo` — there is
 * nothing to classify, and the model correctly answers with low confidence. Paying for that
 * answer and then queueing it for a human is two mistakes: it costs money to produce a
 * non-answer, and it puts a question in front of a curator that has no correct reply.
 *
 * ## This rule is deliberately tiny, and the measurements are why
 *
 * The obvious version is a length threshold, and it does not work. Measured against the
 * corpus, taking the best confidence per skill:
 *
 * | rule | held skills cleared | **confident skills wrongly dropped** |
 * |---|---|---|
 * | summary shorter than 40 chars | 137 | **93** |
 * | summary shorter than 20 chars | 45 | 11 |
 * | two words or fewer | 164 | **71** |
 * | **empty, or a single bare token** | **12** | **2** |
 *
 * Short is not the same as uninformative: "Django performance code review" is 30 characters
 * and perfectly classifiable, while a 90-character description of nothing is not. Most of
 * the low-confidence queue has ordinary descriptions — the classifier is unsure for reasons
 * a length test cannot see, and a threshold tuned to clear the queue would delete good
 * labels to do it.
 *
 * So the rule only catches what is *structurally* empty. It clears about a dozen rows. That
 * is the honest size of this problem, and a rule that claimed more would be buying queue
 * depth with correctness.
 *
 * ## Two confident skills are still excluded, on purpose
 *
 * Two skills with no usable description did get a confident label — from the name alone.
 * They are excluded anyway: a category assigned with no description to read is a guess that
 * happened to sound sure, and `description` is what a consuming agent matches on in the
 * Agent Skills standard. Better unlabelled than labelled from a directory name.
 *
 * ## Not a state, a selector
 *
 * There is no `not_classifiable` column and no migration. The rule is applied where skills
 * are chosen — for classification, for the review queue, for the "remaining" count — so a
 * skill whose description improves upstream becomes eligible again on the next sync with no
 * backfill and nothing to reconcile.
 */

/**
 * A description that is only a bare token — `demo`, `root`, `s`, `input-repo` — or a bare
 * path, which is the same fault wearing a longer string.
 *
 * ## The `/` was added after measuring, like the rest of this rule
 *
 * The class is symlink remnants: a summary that is literally
 * `../../../skills/docs-auditor/SKILL.md` or `../../../commands/okr.md`. A git symlink is
 * stored as a blob whose content is the target path, so over raw.githubusercontent.com the
 * path *is* what comes back — the defect `isSymlink` now filters at enumeration, still
 * present in rows ingested before it did.
 *
 * Measured against the corpus the way the table above was:
 *
 * | rule | held cleared | **confident wrongly dropped** | skills hit |
 * |---|---|---|---|
 * | `^[A-Za-z0-9_.-]+$` (before) | 0 | 1 | 28 |
 * | **`^[A-Za-z0-9_./-]+$`** | **0** | **0** | **129** |
 * | any token with no whitespace | 24 | **23** | 47 |
 *
 * The 101 newly-caught skills have **never been labelled** — not one assignment between
 * them — so this clears nothing from the review queue and is not a queue fix. What it does
 * is stop paying to classify 101 descriptions that are a file path, and stop the
 * low-confidence rows that would follow from ever being queued. About $0.30 today.
 *
 * Small, and stated as small: an earlier read of this claimed these accounted for a quarter
 * of the held queue, which a direct count disproved. The wider "any token with no
 * whitespace" rule is the one that looks tempting and drops 23 confident labels to clear 24
 * held ones — the exact trade the table above exists to refuse.
 *
 * Adding `/` cannot catch prose: every real description contains a space, and this is
 * anchored at both ends.
 */
const SINGLE_TOKEN = "^[A-Za-z0-9_./-]+$";

/**
 * True when the skill has a description worth showing a classifier.
 *
 * Written as SQL rather than TypeScript because every caller needs it inside a query — the
 * selection scan, the review queue and the remaining count all run over the whole table,
 * and pulling rows into node to filter them would be the same rule applied three times at
 * three different scales.
 */
export function isClassifiable(): SQL {
  return sql`(
    ${skills.summary} is not null
    and btrim(${skills.summary}) <> ''
    and btrim(${skills.summary}) !~ ${SINGLE_TOKEN}
  )`;
}

/** The complement, for reporting what was skipped and why. */
export function isNotClassifiable(): SQL {
  return sql`not ${isClassifiable()}`;
}

/** The same rule in TypeScript, for a value already in memory. */
export function summaryIsUsable(summary: string | null | undefined): boolean {
  const trimmed = (summary ?? "").trim();
  if (trimmed.length === 0) return false;
  return !new RegExp(SINGLE_TOKEN).test(trimmed);
}

/** Shown wherever a skipped skill is reported, so the reason travels with the number. */
export const NOT_CLASSIFIABLE_REASON =
  "no usable description — nothing for the classifier to read";
