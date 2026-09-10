CREATE TABLE "campaign_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"draft_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_topics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "capture_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"subject_user_id" text,
	"axis" text,
	"category" text,
	"due_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capture_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_topics" ADD CONSTRAINT "campaign_topics_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_topics" ADD CONSTRAINT "campaign_topics_campaign_id_capture_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."capture_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_topics" ADD CONSTRAINT "campaign_topics_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_campaigns" ADD CONSTRAINT "capture_campaigns_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_campaigns" ADD CONSTRAINT "capture_campaigns_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_campaigns" ADD CONSTRAINT "capture_campaigns_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_topics_uq" ON "campaign_topics" USING btree ("campaign_id",lower("title"));--> statement-breakpoint
CREATE INDEX "campaign_topics_campaign_idx" ON "campaign_topics" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "capture_campaigns_org_idx" ON "capture_campaigns" USING btree ("org_id","status");--> statement-breakpoint
CREATE POLICY "org_scope" ON "campaign_topics" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_scope" ON "capture_campaigns" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));