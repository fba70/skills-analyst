CREATE TABLE "draft_parameters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit" text,
	"meaning" text,
	"source" text DEFAULT 'declared' NOT NULL,
	"decision" text DEFAULT 'accepted' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_parameters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_blocks" ADD COLUMN "rule" jsonb;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "tool_refs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "allowed_tools" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "version_pins" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_parameters" ADD CONSTRAINT "draft_parameters_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_parameters" ADD CONSTRAINT "draft_parameters_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_parameters" ADD CONSTRAINT "draft_parameters_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_parameters_name_uq" ON "draft_parameters" USING btree ("draft_id",lower("name"));--> statement-breakpoint
CREATE INDEX "draft_parameters_draft_idx" ON "draft_parameters" USING btree ("draft_id");--> statement-breakpoint
CREATE POLICY "org_scope" ON "draft_parameters" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));