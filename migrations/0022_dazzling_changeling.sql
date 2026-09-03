DROP INDEX "discovered_repos_uq";--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD COLUMN "owner_folded" text GENERATED ALWAYS AS (lower(owner)) STORED;--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD COLUMN "repo_folded" text GENERATED ALWAYS AS (lower(repo)) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_repos_uq" ON "discovered_repos" USING btree ("host","owner_folded","repo_folded");