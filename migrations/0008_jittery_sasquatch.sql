CREATE TABLE "archetypes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"axis" "category_axis" DEFAULT 'function' NOT NULL,
	"category" text NOT NULL,
	"version" integer NOT NULL,
	"skeleton" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"anti_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exemplar_skill_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"skill_count" integer NOT NULL,
	"distinct_structures" integer NOT NULL,
	"source_count" integer NOT NULL,
	"strong_threshold" smallint,
	"weak_threshold" smallint,
	"extractor_version" text NOT NULL,
	"miner_version" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"changelog" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archetypes" ADD CONSTRAINT "archetypes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archetypes_category_version_uq" ON "archetypes" USING btree ("org_id","axis","category","version");--> statement-breakpoint
CREATE INDEX "archetypes_category_idx" ON "archetypes" USING btree ("axis","category","version");--> statement-breakpoint

-- Tenant isolation for `archetypes` (Doc 3 C4, migration 0002).
--
-- In the same migration as the CREATE TABLE, per the standing rule: RLS defaults to deny,
-- so a new org-scoped table without a policy is invisible to `app_runtime` rather than
-- merely unprotected — the feature looks broken instead of leaky, and the fix arrives a
-- deploy late.
--
-- Every archetype mined from the public corpus carries `org_id IS NULL` and is readable by
-- everyone, which is the point: an archetype is guidance, and Doc 1 makes trust surfaces
-- un-paywallable. The clause is what keeps a Team-tier archetype mined from a private
-- corpus inside its own tenant when R1.9 lands — and RC.5 is explicit that private corpora
-- must never feed public archetypes.

ALTER TABLE "archetypes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_scope" ON "archetypes" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
