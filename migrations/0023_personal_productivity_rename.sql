/*
 * Rename the domain id `productivity-personal` -> `personal-productivity`.
 *
 * ## Why a migration for a rename
 *
 * Category ids are not an enum — `skill_categories.value` is plain `text` validated in
 * TypeScript by `isValidCategory` — so the vocabulary edit alone would leave 604 stored
 * assignments holding an id the vocabulary no longer contains. They would fail validation
 * silently on the next read, and `skills.categories` (376 arrays) would keep serving a label
 * the registry can no longer explain.
 *
 * ## Why rename at all, for a purely cosmetic-looking change
 *
 * It is not cosmetic. Measured over 500 never-labelled skills, the classifier proposed 64
 * invalid ids, and **29 of them — 45% — were `personal-productivity`**. Every other id in the
 * vocabulary reads as natural English (`content-writing`, `media-production`,
 * `science-research`); this one was inverted, so the model kept writing the phrase a person
 * would write. The invalid id was then dropped, which left the skill with one axis, which the
 * both-axes guard rejected. A naming inconsistency of ours was the single largest cause of
 * classification failures.
 *
 * ## Safety
 *
 * `skill_categories_uq` is `(skill_id, axis, value)`, so a skill holding *both* ids would
 * collide on update. Checked before writing: 604 rows carry the old id, 0 carry the new one,
 * and 0 skills hold both. The guard is kept in the statement anyway rather than trusted to a
 * one-off query — a migration that is only correct because of something someone checked once
 * is a migration that breaks when it is replayed on another database.
 */

DELETE FROM skill_categories old
WHERE old.value = 'productivity-personal'
  AND EXISTS (
    SELECT 1 FROM skill_categories keep
    WHERE keep.skill_id = old.skill_id
      AND keep.axis = old.axis
      AND keep.value = 'personal-productivity'
  );--> statement-breakpoint

UPDATE skill_categories SET value = 'personal-productivity'
WHERE value = 'productivity-personal';--> statement-breakpoint

/*
 * The denormalised read path. `array_replace` is a no-op on arrays that do not contain the
 * old value, so this needs no WHERE clause for correctness — it has one for speed, since the
 * table holds ~50k rows and 376 of them are affected.
 */
UPDATE skills
SET categories = array_replace(categories, 'productivity-personal', 'personal-productivity')
WHERE 'productivity-personal' = ANY(categories);
