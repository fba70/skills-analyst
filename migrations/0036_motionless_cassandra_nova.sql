CREATE TABLE "skill_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid,
	"skill_id" uuid,
	"source_hash" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_tokens" integer NOT NULL,
	"variant_tokens" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"outcome" text DEFAULT 'unverified' NOT NULL,
	"model" text NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "skill_variants_one_parent" CHECK ((draft_id is null) <> (skill_id is null))
);
--> statement-breakpoint
ALTER TABLE "skill_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_variants" ADD CONSTRAINT "skill_variants_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_variants" ADD CONSTRAINT "skill_variants_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_variants" ADD CONSTRAINT "skill_variants_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_variants" ADD CONSTRAINT "skill_variants_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_variants_draft_idx" ON "skill_variants" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_variants_skill_idx" ON "skill_variants" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_variants" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));