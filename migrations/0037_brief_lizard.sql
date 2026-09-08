CREATE TABLE "link_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"status_code" smallint,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"first_failed_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_checks_uq" ON "link_checks" USING btree ("skill_version_id","url");--> statement-breakpoint
CREATE INDEX "link_checks_status_idx" ON "link_checks" USING btree ("status","consecutive_failures");--> statement-breakpoint
CREATE INDEX "link_checks_due_idx" ON "link_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE POLICY "org_scope" ON "link_checks" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));