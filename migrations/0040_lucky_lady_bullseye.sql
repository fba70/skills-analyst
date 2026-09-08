CREATE TABLE "skill_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"from_skill_id" uuid NOT NULL,
	"to_skill_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"detail" text,
	"miner_version" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_relations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_relations" ADD CONSTRAINT "skill_relations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_relations" ADD CONSTRAINT "skill_relations_from_skill_id_skills_id_fk" FOREIGN KEY ("from_skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_relations" ADD CONSTRAINT "skill_relations_to_skill_id_skills_id_fk" FOREIGN KEY ("to_skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_relations" ADD CONSTRAINT "skill_relations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_relations_uq" ON "skill_relations" USING btree ("from_skill_id","to_skill_id","kind");--> statement-breakpoint
CREATE INDEX "skill_relations_from_idx" ON "skill_relations" USING btree ("from_skill_id","kind");--> statement-breakpoint
CREATE INDEX "skill_relations_miner_idx" ON "skill_relations" USING btree ("source","miner_version");--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_relations" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));