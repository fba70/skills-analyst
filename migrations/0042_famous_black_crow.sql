CREATE TABLE "skill_scope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"analyser_version" text NOT NULL,
	"embedder_version" text NOT NULL,
	"blocks" integer NOT NULL,
	"cohesion" real NOT NULL,
	"separation" real,
	"type_purity" real,
	"verdict" text NOT NULL,
	"clusters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_bytes" integer NOT NULL,
	"oversized" boolean DEFAULT false NOT NULL,
	"movable_tokens" integer DEFAULT 0 NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_scope" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_scope" ADD CONSTRAINT "skill_scope_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_scope" ADD CONSTRAINT "skill_scope_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_scope" ADD CONSTRAINT "skill_scope_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_scope_uq" ON "skill_scope" USING btree ("skill_version_id","analyser_version");--> statement-breakpoint
CREATE INDEX "skill_scope_verdict_idx" ON "skill_scope" USING btree ("analyser_version","verdict");--> statement-breakpoint
CREATE INDEX "skill_scope_version_idx" ON "skill_scope" USING btree ("skill_id","analyser_version");--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_scope" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));