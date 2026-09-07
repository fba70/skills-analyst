CREATE TYPE "public"."flag_reason" AS ENUM('malicious', 'prompt-injection', 'secret', 'misleading', 'broken', 'licence', 'duplicate', 'other');--> statement-breakpoint
CREATE TYPE "public"."flag_status" AS ENUM('received', 'upheld', 'rejected');--> statement-breakpoint
CREATE TABLE "skill_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"reason" "flag_reason" NOT NULL,
	"note" text,
	"contact" text,
	"status" "flag_status" DEFAULT 'received' NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"reporter_digest" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_flags" ADD CONSTRAINT "skill_flags_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_flags" ADD CONSTRAINT "skill_flags_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_flags" ADD CONSTRAINT "skill_flags_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_flags" ADD CONSTRAINT "skill_flags_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_flags_uq" ON "skill_flags" USING btree ("skill_version_id","reason","day","reporter_digest");--> statement-breakpoint
CREATE INDEX "skill_flags_status_idx" ON "skill_flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "skill_flags_skill_idx" ON "skill_flags" USING btree ("skill_id");--> statement-breakpoint
CREATE POLICY "read_all" ON "skill_flags" AS PERMISSIVE FOR SELECT TO "app_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "org_write" ON "skill_flags" AS PERMISSIVE FOR INSERT TO "app_runtime" WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_decide" ON "skill_flags" AS PERMISSIVE FOR UPDATE TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));