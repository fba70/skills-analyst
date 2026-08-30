CREATE TABLE "skill_duplicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"canonical_skill_id" uuid NOT NULL,
	"duplicate_skill_id" uuid NOT NULL,
	"similarity" real NOT NULL,
	"estimated_similarity" real,
	"algorithm_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_signature_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"band_index" smallint NOT NULL,
	"band_hash" text NOT NULL,
	"algorithm_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_version_id" uuid NOT NULL,
	"algorithm" text DEFAULT 'minhash' NOT NULL,
	"algorithm_version" text NOT NULL,
	"signature" integer[] NOT NULL,
	"shingle_count" integer NOT NULL,
	"text_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_duplicates" ADD CONSTRAINT "skill_duplicates_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_duplicates" ADD CONSTRAINT "skill_duplicates_canonical_skill_id_skills_id_fk" FOREIGN KEY ("canonical_skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_duplicates" ADD CONSTRAINT "skill_duplicates_duplicate_skill_id_skills_id_fk" FOREIGN KEY ("duplicate_skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signature_bands" ADD CONSTRAINT "skill_signature_bands_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signature_bands" ADD CONSTRAINT "skill_signature_bands_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signature_bands" ADD CONSTRAINT "skill_signature_bands_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signatures" ADD CONSTRAINT "skill_signatures_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signatures" ADD CONSTRAINT "skill_signatures_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_duplicates_uq" ON "skill_duplicates" USING btree ("canonical_skill_id","duplicate_skill_id");--> statement-breakpoint
CREATE INDEX "skill_duplicates_dup_idx" ON "skill_duplicates" USING btree ("duplicate_skill_id");--> statement-breakpoint
CREATE INDEX "skill_signature_bands_lookup_idx" ON "skill_signature_bands" USING btree ("band_index","band_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_signature_bands_uq" ON "skill_signature_bands" USING btree ("skill_version_id","band_index","algorithm_version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_signatures_uq" ON "skill_signatures" USING btree ("skill_version_id","algorithm","algorithm_version");--> statement-breakpoint

-- RLS in the same migration as the tables, per CLAUDE.md: a new org-scoped table without
-- a policy is invisible to the app rather than merely unprotected.
ALTER TABLE "skill_signatures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_signature_bands" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_duplicates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_signatures" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_signature_bands" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_duplicates" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "skill_signatures", "skill_signature_bands", "skill_duplicates" TO app_runtime;
