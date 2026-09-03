/*
 * One repository, one row — folding case into the identity indexes, and merging the
 * duplicate repositories the case-sensitive ones already let in.
 *
 * ## What was wrong
 *
 * GitHub resolves `owner/repo` case-insensitively. Our identity indexes did not:
 * `sources_public_url_uq` was on the raw `url` and `discovered_repos_uq` on the raw
 * `(owner, repo)`. So when code search reported `NVIDIA/skills` on one crawl day and
 * `nvidia/skills` on another, the second was a *new* candidate, `promote()` matched
 * `sources` on `url =` and found nothing, and the repository got a second source row.
 *
 * Measured on 2026-09-03: 40 duplicate `discovered_repos` groups and 14 duplicate public
 * `sources` groups. `NVIDIA/skills` held 268 indexed skills and `nvidia/skills` another 99
 * — one repository fetched twice, its skills split across two rows, its GitHub quota spent
 * twice, and both rows counted separately in every per-source statistic. Archetype banding
 * read the split as one curated source and one untrusted one.
 *
 * Nothing errored, because two rows was exactly what these indexes permitted.
 *
 * ## Why the merge is in the same migration as the indexes
 *
 * The new indexes cannot be created while the duplicates exist, and the duplicates must not
 * be merged while the old indexes still allow more to arrive. Splitting this into "repair
 * script, then migration" would leave a window where a crawl re-creates what the script
 * just merged. One transaction, or neither half is safe.
 *
 * ## The merge rules, and what each one protects
 *
 * **Winner: most versions, then oldest, then id.** Most versions keeps the larger half of a
 * split; oldest is the row that carries GitHub's own casing (`NVIDIA`, not `nvidia`), which
 * is what an attribution list should show; id makes it deterministic so a re-run cannot pick
 * differently.
 *
 * **`kind` stays in the key.** `ComposioHQ/awesome-claude-skills` is on the seed *list*
 * allow-list, read for the repo links inside it, and the crawl separately promoted it as a
 * content repo shipping six skills of its own. Two connectors, two legitimate reads of one
 * URL. Folding without `kind` would have forced one to be deleted. It does not reopen the
 * bug: the 14 duplicate groups are all a single `kind`, so `(lower(url), kind)` still
 * collides on them — which is why 14 groups here and not 15.
 *
 * **Curator decisions survive.** `config` merges as `loser || winner`: the winner's values
 * win a conflict and the loser's extra keys are kept, so an `allowLargeRepo`, an
 * `approvedBy` or an `includePaths` recorded against the row being deleted is not silently
 * discarded. That is the same failure this repo has already fixed three times — a decision
 * recorded and then ignored.
 *
 * **25 skills are deleted, and only these 25.** Three repositories had the same upstream
 * *path* fetched under both casings (NVIDIA 22, deanpeters 1, wanshuiyin 2). After
 * repointing they would be two `skills` rows with one `(source_id, path)`, and the write
 * path resolves that key with `limit(1)` and no `ORDER BY` — so the next sync would update
 * an arbitrary one and leave the other permanently stale: never refreshed, and never
 * tombstoned either, because its path is still in the enumeration.
 *
 * The staler *fetch* loses, not the losing source's copy — in all 25 cases the fresher
 * content came through the lowercase row, and three of them scored better for it
 * (`vss-manage-alerts` 19 → 59). Both rows describe one upstream file; the newer read is the
 * current one.
 *
 * Deleted rather than linked under `canonical_skill_id`, deliberately. That column is owned
 * by `analytics/dedupe.ts`, whose `--reset` clears every value in the table — so a variant
 * link written here would be undone by an unrelated dedup re-run, restoring the ambiguity
 * with nobody watching. These rows are an artefact of our own bug, not upstream content, and
 * the bytes are re-fetchable.
 *
 * Verified before writing: 25 distinct skills, 0 referenced by a takedown, 0 held as an
 * archetype exemplar. Every FK from `skills` cascades or sets null, so nothing is orphaned.
 */

DROP INDEX "sources_org_url_uq";--> statement-breakpoint
DROP INDEX "sources_public_url_uq";--> statement-breakpoint
DROP INDEX "discovered_repos_uq";--> statement-breakpoint

CREATE TEMP TABLE "_0021_source_merge" AS
WITH ranked AS (
  SELECT
    s.id,
    lower(s.url) AS folded,
    s.kind,
    row_number() OVER (
      PARTITION BY lower(s.url), s.kind
      ORDER BY (SELECT count(*) FROM skill_versions v WHERE v.source_id = s.id) DESC,
               s.created_at,
               s.id
    ) AS rn
  FROM sources s
  WHERE s.org_id IS NULL
)
SELECT w.id AS winner, l.id AS loser
FROM ranked w
JOIN ranked l
  ON l.folded = w.folded AND l.kind = w.kind AND w.rn = 1 AND l.rn > 1;
--> statement-breakpoint

-- Same upstream path on both rows: keep the fresher fetch, delete the staler skill.
-- Cascades take its versions, verdicts, structures, categories, signals and signatures.
DELETE FROM skills WHERE id IN (
  SELECT CASE WHEN wv.synced_at >= lv.synced_at THEN lv.skill_id ELSE wv.skill_id END
  FROM "_0021_source_merge" m
  JOIN skill_versions wv ON wv.source_id = m.winner
  JOIN skill_versions lv ON lv.source_id = m.loser
   AND lv.provenance->>'path' = wv.provenance->>'path'
);
--> statement-breakpoint

-- Carry the loser's config keys, and the later of the two sync timestamps, onto the winner.
UPDATE sources w
SET config = losers.merged || w.config,
    last_sync_at = greatest(w.last_sync_at, losers.last_sync_at),
    last_success_at = greatest(w.last_success_at, losers.last_success_at),
    updated_at = now()
FROM (
  SELECT m.winner,
         coalesce(jsonb_object_agg(k.key, k.value) FILTER (WHERE k.key IS NOT NULL), '{}'::jsonb) AS merged,
         max(s.last_sync_at) AS last_sync_at,
         max(s.last_success_at) AS last_success_at
  FROM "_0021_source_merge" m
  JOIN sources s ON s.id = m.loser
  LEFT JOIN LATERAL jsonb_each(s.config) k ON true
  GROUP BY m.winner
) AS losers
WHERE w.id = losers.winner;
--> statement-breakpoint

-- `skill_signals_uq` is (skill_id, source_id, kind, observed_at). Repointing cannot be
-- allowed to violate it, so drop the few that would collide before moving the rest.
DELETE FROM skill_signals si
USING "_0021_source_merge" m
WHERE si.source_id = m.loser
  AND EXISTS (
    SELECT 1 FROM skill_signals w
    WHERE w.skill_id = si.skill_id
      AND w.source_id = m.winner
      AND w.kind = si.kind
      AND w.observed_at = si.observed_at
  );
--> statement-breakpoint

UPDATE skill_signals si SET source_id = m.winner
FROM "_0021_source_merge" m WHERE si.source_id = m.loser;
--> statement-breakpoint

UPDATE skill_versions v SET source_id = m.winner
FROM "_0021_source_merge" m WHERE v.source_id = m.loser;
--> statement-breakpoint

UPDATE discovered_repos d SET source_id = m.winner
FROM "_0021_source_merge" m WHERE d.source_id = m.loser;
--> statement-breakpoint

UPDATE takedowns t SET source_id = m.winner
FROM "_0021_source_merge" m WHERE t.source_id = m.loser;
--> statement-breakpoint

DELETE FROM sources WHERE id IN (SELECT loser FROM "_0021_source_merge");
--> statement-breakpoint

/*
 * Duplicate candidates, the upstream half of the same bug.
 *
 * Winner prefers a row that is already linked to a source, then one already `promoted`, then
 * the earliest sighting. That order matters: `promote()` writes `source_id` onto the
 * candidate it acted on, and picking the unlinked twin would orphan that link and let the
 * repository be offered for promotion a second time.
 *
 * `hit_count` takes the max rather than the sum. It records what *code search* reported for
 * one sighting of this repository, and adding two independent sightings together would
 * invent evidence — the same distinction this repo already had to make between `hit_count`
 * and a full enumeration's marker count.
 */
CREATE TEMP TABLE "_0021_repo_merge" AS
WITH ranked AS (
  SELECT
    d.id, d.host, lower(d.owner) AS o, lower(d.repo) AS r,
    row_number() OVER (
      PARTITION BY d.host, lower(d.owner), lower(d.repo)
      ORDER BY (d.source_id IS NULL), (d.status <> 'promoted'), d.first_seen_at, d.id
    ) AS rn
  FROM discovered_repos d
)
SELECT w.id AS winner, l.id AS loser
FROM ranked w
JOIN ranked l
  ON l.host = w.host AND l.o = w.o AND l.r = w.r AND w.rn = 1 AND l.rn > 1;
--> statement-breakpoint

UPDATE discovered_repos w
SET hit_count = greatest(w.hit_count, losers.hit_count),
    last_seen_at = greatest(w.last_seen_at, losers.last_seen_at),
    stars = coalesce(w.stars, losers.stars),
    byte_size = coalesce(w.byte_size, losers.byte_size),
    default_branch = coalesce(w.default_branch, losers.default_branch),
    submitted_by = coalesce(w.submitted_by, losers.submitted_by),
    -- Scalar subquery, not an aggregate: `sample_paths` is `text[]`, and `array_agg` over it
    -- returns a 2-D array whose subscript is an element rather than a row — which fails as
    -- `COALESCE types text[] and text cannot be matched`. Caught by the dry-run, not in prod.
    sample_paths = coalesce(
      w.sample_paths,
      (SELECT d2.sample_paths
         FROM "_0021_repo_merge" m2
         JOIN discovered_repos d2 ON d2.id = m2.loser
        WHERE m2.winner = w.id AND d2.sample_paths IS NOT NULL
        ORDER BY d2.id
        LIMIT 1)
    )
FROM (
  SELECT m.winner,
         max(d.hit_count) AS hit_count,
         max(d.last_seen_at) AS last_seen_at,
         max(d.stars) AS stars,
         max(d.byte_size) AS byte_size,
         min(d.default_branch) AS default_branch,
         min(d.submitted_by) AS submitted_by
  FROM "_0021_repo_merge" m
  JOIN discovered_repos d ON d.id = m.loser
  GROUP BY m.winner
) AS losers
WHERE w.id = losers.winner;
--> statement-breakpoint

DELETE FROM discovered_repos WHERE id IN (SELECT loser FROM "_0021_repo_merge");
--> statement-breakpoint

DROP TABLE "_0021_source_merge";--> statement-breakpoint
DROP TABLE "_0021_repo_merge";--> statement-breakpoint

CREATE UNIQUE INDEX "sources_org_url_uq" ON "sources" USING btree ("org_id",lower("url"),"kind");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_public_url_uq" ON "sources" USING btree (lower("url"),"kind") WHERE "sources"."org_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_repos_uq" ON "discovered_repos" USING btree ("host",lower("owner"),lower("repo"));
