CREATE TABLE "draft_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"block_order" smallint NOT NULL,
	"form" text NOT NULL,
	"depth" smallint,
	"type" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "draft_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"blocks" jsonb NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_blocks" ADD CONSTRAINT "draft_blocks_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_blocks" ADD CONSTRAINT "draft_blocks_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_blocks_uq" ON "draft_blocks" USING btree ("draft_id","block_order");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_revisions_uq" ON "draft_revisions" USING btree ("draft_id","revision");--> statement-breakpoint
CREATE POLICY "org_scope" ON "draft_blocks" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_read" ON "draft_revisions" AS PERMISSIVE FOR SELECT TO "app_runtime" USING (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_append" ON "draft_revisions" AS PERMISSIVE FOR INSERT TO "app_runtime" WITH CHECK (org_id = current_setting('app.org_id', true));