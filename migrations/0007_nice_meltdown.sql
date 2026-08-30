-- One public source per URL.
--
-- The existing `sources_org_url_uq` on (org_id, url) looks like it already guarantees this
-- and does not: Postgres treats NULLs as distinct in a unique index, and `org_id` is NULL
-- for every public source, so `(NULL, url)` never conflicted with `(NULL, url)`. The public
-- corpus — which is all of it today — has been unconstrained since 0000.
--
-- The damage was real but small: expanding the same curated list three times left three
-- `VoltAgent/awesome-agent-skills` rows. `promote()` had also grown a select-then-insert to
-- work around the missing guarantee; that can now rely on the constraint instead.
--
-- Duplicates are collapsed first, keeping the oldest row of each URL, because the index
-- cannot be created while they exist. Nothing references the discarded rows: a duplicate
-- source row was never synced, so it owns no skill_versions.

DELETE FROM "sources"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           row_number() OVER (PARTITION BY "url" ORDER BY "created_at", "id") AS rn
    FROM "sources"
    WHERE "org_id" IS NULL
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_public_url_uq" ON "sources" USING btree ("url") WHERE "sources"."org_id" is null;