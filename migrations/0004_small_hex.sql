ALTER TYPE "public"."discovered_repo_status" ADD VALUE 'enriched' BEFORE 'promoted';--> statement-breakpoint
ALTER TYPE "public"."discovered_repo_status" ADD VALUE 'needs_review' BEFORE 'skipped';--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD COLUMN "archived" boolean;--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD COLUMN "default_branch" text;--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD COLUMN "enriched_at" timestamp with time zone;