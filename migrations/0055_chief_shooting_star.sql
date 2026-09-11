ALTER TYPE "public"."llm_purpose" ADD VALUE 'corpus_parameters';--> statement-breakpoint
CREATE TABLE "skill_parameters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"analyser_version" text NOT NULL,
	"model" text NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocks_read" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_parameters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_parameters" ADD CONSTRAINT "skill_parameters_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_parameters" ADD CONSTRAINT "skill_parameters_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_parameters" ADD CONSTRAINT "skill_parameters_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_parameters_uq" ON "skill_parameters" USING btree ("skill_version_id","analyser_version");--> statement-breakpoint
CREATE INDEX "skill_parameters_skill_idx" ON "skill_parameters" USING btree ("skill_id","analyser_version");--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_parameters" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));