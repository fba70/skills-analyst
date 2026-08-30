CREATE TYPE "public"."category_assigned_by" AS ENUM('classifier', 'curator', 'heuristic');--> statement-breakpoint
CREATE TYPE "public"."category_axis" AS ENUM('domain', 'function');--> statement-breakpoint
CREATE TABLE "skill_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"extractor_version" text NOT NULL,
	"headings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"heading_count" integer DEFAULT 0 NOT NULL,
	"max_heading_depth" smallint DEFAULT 0 NOT NULL,
	"body_bytes" integer DEFAULT 0 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"code_block_count" integer DEFAULT 0 NOT NULL,
	"code_languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"list_item_count" integer DEFAULT 0 NOT NULL,
	"table_count" integer DEFAULT 0 NOT NULL,
	"prose_ratio" smallint DEFAULT 0 NOT NULL,
	"link_count" integer DEFAULT 0 NOT NULL,
	"internal_link_count" integer DEFAULT 0 NOT NULL,
	"broken_link_count" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 1 NOT NULL,
	"has_scripts" boolean DEFAULT false NOT NULL,
	"has_references" boolean DEFAULT false NOT NULL,
	"has_assets" boolean DEFAULT false NOT NULL,
	"has_templates" boolean DEFAULT false NOT NULL,
	"resource_dirs" text[] DEFAULT '{}'::text[] NOT NULL,
	"file_extensions" text[] DEFAULT '{}'::text[] NOT NULL,
	"frontmatter_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"description_length" integer DEFAULT 0 NOT NULL,
	"description_shape" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"axis" "category_axis" NOT NULL,
	"value" text NOT NULL,
	"confidence" smallint NOT NULL,
	"assigned_by" "category_assigned_by" NOT NULL,
	"classifier_version" text NOT NULL,
	"model" text,
	"rationale" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovered_repos" ADD COLUMN "submitted_by" text;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD CONSTRAINT "skill_structures_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD CONSTRAINT "skill_structures_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD CONSTRAINT "skill_structures_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_categories" ADD CONSTRAINT "skill_categories_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_categories" ADD CONSTRAINT "skill_categories_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_structures_uq" ON "skill_structures" USING btree ("skill_version_id","extractor_version");--> statement-breakpoint
CREATE INDEX "skill_structures_skill_idx" ON "skill_structures" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_structures_roles_idx" ON "skill_structures" USING gin ("section_roles");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_categories_uq" ON "skill_categories" USING btree ("skill_id","axis","value");--> statement-breakpoint
CREATE INDEX "skill_categories_axis_idx" ON "skill_categories" USING btree ("axis","value");--> statement-breakpoint
CREATE INDEX "skill_categories_review_idx" ON "skill_categories" USING btree ("confidence","reviewed_at");--> statement-breakpoint

-- Tenant isolation for the two new org-scoped tables (Doc 3 C4, migration 0002).
--
-- In the same migration as the CREATE TABLE, deliberately. A new org-scoped table without
-- a policy is not "unprotected but working" — RLS defaults to deny, so `app_runtime`
-- would see zero rows and the feature would look broken rather than leaky. Splitting the
-- policy into a follow-up migration guarantees one deploy where mining reads nothing.
--
-- `org_id IS NULL` is the public corpus. Every fingerprint and every category the crawl
-- produces is public, so in practice these read wide open today; the clause is what keeps
-- a Team-tier private skill's structure and labels inside its own tenant when R1.9 lands.

ALTER TABLE "skill_structures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_structures" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_categories" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
