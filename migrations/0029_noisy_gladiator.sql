CREATE TABLE "outcome_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"archetype_category" text,
	"archetype_version" integer,
	"day" date NOT NULL,
	"caller_digest" text NOT NULL,
	"value" real,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outcome_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outcome_signals" ADD CONSTRAINT "outcome_signals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_signals" ADD CONSTRAINT "outcome_signals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_signals" ADD CONSTRAINT "outcome_signals_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_signals_uq" ON "outcome_signals" USING btree ("skill_version_id","kind","day","caller_digest");--> statement-breakpoint
CREATE INDEX "outcome_signals_skill_idx" ON "outcome_signals" USING btree ("skill_id","kind");--> statement-breakpoint
CREATE INDEX "outcome_signals_archetype_idx" ON "outcome_signals" USING btree ("archetype_category","archetype_version");--> statement-breakpoint
CREATE INDEX "outcome_signals_day_idx" ON "outcome_signals" USING btree ("day");--> statement-breakpoint
CREATE POLICY "read_all" ON "outcome_signals" AS PERMISSIVE FOR SELECT TO "app_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "org_write" ON "outcome_signals" AS PERMISSIVE FOR INSERT TO "app_runtime" WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));