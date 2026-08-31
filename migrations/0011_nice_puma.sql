CREATE TYPE "public"."draft_status" AS ENUM('collecting', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "skill_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"created_by" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"dialect" "skill_dialect" DEFAULT 'anthropic_skill' NOT NULL,
	"archetype_category" text NOT NULL,
	"archetype_version" integer,
	"purpose" text NOT NULL,
	"context" text,
	"section_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "draft_status" DEFAULT 'collecting' NOT NULL,
	"body" text,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"generated_at" timestamp with time zone,
	"failure_reason" text,
	"validation" jsonb,
	"quality_score" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_drafts_org_idx" ON "skill_drafts" USING btree ("org_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "skill_drafts_status_idx" ON "skill_drafts" USING btree ("status");--> statement-breakpoint

-- Tenant isolation for `skill_drafts` (Doc 3 C4, migration 0002).
--
-- In the same migration as the CREATE TABLE, per the standing rule: RLS defaults to deny,
-- so a new table without a policy is invisible to `app_runtime` rather than merely
-- unprotected.
--
-- **Stricter than every other policy in this schema, on purpose.** The corpus tables allow
-- `org_id IS NULL` because NULL means "public" there. A draft is never public — the column
-- is NOT NULL and there is no anonymous case to admit — so the escape hatch is absent. An
-- unauthenticated request sets no `app.org_id`, `current_setting` returns NULL, and the
-- comparison yields NULL rather than true: no rows, which is the correct answer.

ALTER TABLE "skill_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_drafts" FOR ALL TO app_runtime
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
