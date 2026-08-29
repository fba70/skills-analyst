CREATE TYPE "public"."crawl_shard_status" AS ENUM('pending', 'running', 'complete', 'saturated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."discovered_repo_status" AS ENUM('new', 'promoted', 'skipped');--> statement-breakpoint
CREATE TABLE "crawl_shards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"query" text NOT NULL,
	"bounds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_id" uuid,
	"status" "crawl_shard_status" DEFAULT 'pending' NOT NULL,
	"reported_total" integer,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"repos_found" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovered_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"host" text DEFAULT 'github.com' NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"url" text NOT NULL,
	"is_fork" boolean,
	"parent_repo" text,
	"stars" integer,
	"pushed_at" timestamp with time zone,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"sample_paths" text[],
	"status" "discovered_repo_status" DEFAULT 'new' NOT NULL,
	"skip_reason" text,
	"source_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"byte_size" bigint
);
--> statement-breakpoint
ALTER TABLE "crawl_shards" ADD CONSTRAINT "crawl_shards_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD CONSTRAINT "discovered_repos_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD CONSTRAINT "discovered_repos_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_shards_query_uq" ON "crawl_shards" USING btree ("query");--> statement-breakpoint
CREATE INDEX "crawl_shards_status_idx" ON "crawl_shards" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "crawl_shards_parent_idx" ON "crawl_shards" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_repos_uq" ON "discovered_repos" USING btree ("host","owner","repo");--> statement-breakpoint
CREATE INDEX "discovered_repos_status_idx" ON "discovered_repos" USING btree ("status","stars");--> statement-breakpoint
CREATE INDEX "discovered_repos_fork_idx" ON "discovered_repos" USING btree ("is_fork");--> statement-breakpoint

-- RLS for the two new org-scoped tables. Added in the SAME migration as the tables, per
-- CLAUDE.md: a new org-scoped table without a policy is invisible to the app rather than
-- merely unprotected, and a backstop bolted on later is not a backstop.
ALTER TABLE "crawl_shards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discovered_repos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_scope" ON "crawl_shards" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "discovered_repos" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
-- The runtime role predates these tables, so the schema-wide grant does not cover them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "crawl_shards", "discovered_repos" TO app_runtime;
