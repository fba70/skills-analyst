CREATE TABLE "draft_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "imported_from_version_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "import_attribution" jsonb;--> statement-breakpoint
ALTER TABLE "draft_resources" ADD CONSTRAINT "draft_resources_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_resources" ADD CONSTRAINT "draft_resources_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_resources_uq" ON "draft_resources" USING btree ("draft_id","path");--> statement-breakpoint
CREATE INDEX "draft_resources_draft_idx" ON "draft_resources" USING btree ("draft_id");--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_imported_from_version_id_skill_versions_id_fk" FOREIGN KEY ("imported_from_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "org_scope" ON "draft_resources" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));