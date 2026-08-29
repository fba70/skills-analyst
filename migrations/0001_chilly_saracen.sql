CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'analyzer', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."license_source" AS ENUM('frontmatter', 'in_tree_license', 'github_api', 'clearlydefined', 'scancode', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."redistribution_posture" AS ENUM('mirror_allowed', 'attribution_required', 'metadata_only', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."signal_kind" AS ENUM('stars', 'forks', 'watchers', 'downloads', 'installs', 'open_issues', 'registry_rank');--> statement-breakpoint
CREATE TYPE "public"."skill_dialect" AS ENUM('anthropic_skill', 'claude_plugin', 'openclaw_skill', 'cursor_rule', 'agents_md', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."skill_status" AS ENUM('pending', 'indexed', 'quarantined', 'tombstoned');--> statement-breakpoint
CREATE TYPE "public"."skill_version_status" AS ENUM('pending', 'validating', 'indexed', 'quarantined', 'revalidating', 'tombstoned');--> statement-breakpoint
CREATE TYPE "public"."source_health" AS ENUM('unknown', 'healthy', 'degraded', 'failing', 'paused');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('github_repo', 'github_code_search', 'awesome_list', 'clawhub', 'manual_submission');--> statement-breakpoint
CREATE TYPE "public"."verdict_result" AS ENUM('pass', 'warn', 'fail', 'error');--> statement-breakpoint
CREATE TYPE "public"."verdict_severity" AS ENUM('info', 'low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TABLE "skill_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" "signal_kind" NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text,
	"content_stored" boolean DEFAULT false NOT NULL,
	"byte_size" bigint,
	"file_count" integer,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"license_spdx" text,
	"license_source" "license_source" DEFAULT 'unresolved' NOT NULL,
	"license_evidence" jsonb,
	"redistribution" "redistribution_posture" DEFAULT 'unresolved' NOT NULL,
	"status" "skill_version_status" DEFAULT 'pending' NOT NULL,
	"quarantine_reasons" text[],
	"upstream_ref" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"canonical_skill_id" uuid,
	"dialect" "skill_dialect" DEFAULT 'unknown' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "skill_status" DEFAULT 'pending' NOT NULL,
	"quality_score" smallint,
	"current_version_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"kind" "source_kind" NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health" "source_health" DEFAULT 'unknown' NOT NULL,
	"health_detail" jsonb,
	"schedule" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"cursor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_version_id" uuid NOT NULL,
	"analyzer" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"surface" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"undocumented" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_version_id" uuid NOT NULL,
	"analyzer" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"model_id" text,
	"result" "verdict_result" NOT NULL,
	"severity" "verdict_severity" DEFAULT 'info' NOT NULL,
	"reason" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_signals" ADD CONSTRAINT "skill_signals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signals" ADD CONSTRAINT "skill_signals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_signals" ADD CONSTRAINT "skill_signals_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_canonical_skill_id_fk" FOREIGN KEY ("canonical_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_surfaces" ADD CONSTRAINT "capability_surfaces_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_surfaces" ADD CONSTRAINT "capability_surfaces_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_signals_lookup_idx" ON "skill_signals" USING btree ("skill_id","kind","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_signals_uq" ON "skill_signals" USING btree ("skill_id","source_id","kind","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_content_hash_uq" ON "skill_versions" USING btree ("content_hash") WHERE status <> 'tombstoned';--> statement-breakpoint
CREATE INDEX "skill_versions_skill_idx" ON "skill_versions" USING btree ("skill_id","synced_at");--> statement-breakpoint
CREATE INDEX "skill_versions_source_idx" ON "skill_versions" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "skill_versions_status_idx" ON "skill_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_org_slug_uq" ON "skills" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "skills_status_idx" ON "skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "skills_canonical_idx" ON "skills" USING btree ("canonical_skill_id");--> statement-breakpoint
CREATE INDEX "skills_categories_idx" ON "skills" USING gin ("categories");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_org_url_uq" ON "sources" USING btree ("org_id","url");--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled","health");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_type","subject_id","at");--> statement-breakpoint
CREATE INDEX "events_kind_idx" ON "events" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_surfaces_uq" ON "capability_surfaces" USING btree ("skill_version_id","analyzer","analyzer_version");--> statement-breakpoint
CREATE INDEX "verdicts_version_idx" ON "verdicts" USING btree ("skill_version_id","analyzer","created_at");--> statement-breakpoint
CREATE INDEX "verdicts_analyzer_idx" ON "verdicts" USING btree ("analyzer","analyzer_version");