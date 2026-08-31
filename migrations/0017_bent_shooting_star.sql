-- Search: relevance and fuzzy matching (Doc 2 R7.4; the relevance term R2.9 was missing).
--
-- Before this, search was `ilike '%q%'` over name, summary and slug. A leading `%` means no
-- btree can serve it and there was no textual index on `skills` at all, so every search was
-- a sequential scan — and because a LIKE match carries no notion of *where* it matched,
-- results then fell through to the quality sort: a skill named after the query ranked below
-- an unrelated higher-scoring one that merely mentioned it.
--
-- Two indexes, because they fail in opposite directions. The tsvector handles words and
-- stemming and cannot handle a typo; the trigram index handles typos and partial words and
-- has no notion of a word at all. The query ORs them.
--
-- `CREATE EXTENSION` is hand-written: drizzle-kit does not generate extensions, and the
-- trigram index below cannot be created without it. It must stay above that index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce("name", '')), 'A')
       || setweight(to_tsvector('english'::regconfig, coalesce("summary", '')), 'B')
       || setweight(to_tsvector('english'::regconfig, replace(coalesce("slug", ''), '-', ' ')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "skills_search_idx" ON "skills" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "skills_name_trgm_idx" ON "skills" USING gin ("name" gin_trgm_ops);