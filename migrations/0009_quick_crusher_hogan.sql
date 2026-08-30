CREATE TYPE "public"."takedown_grounds" AS ENUM('copyright', 'license_violation', 'privacy', 'trademark', 'author_request', 'other');--> statement-breakpoint
CREATE TYPE "public"."takedown_scope" AS ENUM('skill', 'source');--> statement-breakpoint
CREATE TYPE "public"."takedown_status" AS ENUM('received', 'upheld', 'rejected', 'reinstated');--> statement-breakpoint
ALTER TYPE "public"."skill_status" ADD VALUE 'withdrawn';--> statement-breakpoint
ALTER TYPE "public"."skill_version_status" ADD VALUE 'withdrawn';--> statement-breakpoint
CREATE TABLE "takedowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"scope" "takedown_scope" NOT NULL,
	"source_url" text NOT NULL,
	"skill_path" text,
	"skill_id" uuid,
	"source_id" uuid,
	"requester" text NOT NULL,
	"requester_email" text,
	"grounds" "takedown_grounds" NOT NULL,
	"claim" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "takedown_status" DEFAULT 'received' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"content_deleted" boolean DEFAULT false NOT NULL,
	"affected_skills" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "takedowns" ADD CONSTRAINT "takedowns_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takedowns" ADD CONSTRAINT "takedowns_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takedowns" ADD CONSTRAINT "takedowns_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takedowns" ADD CONSTRAINT "takedowns_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "takedowns_block_idx" ON "takedowns" USING btree ("source_url","skill_path","status");--> statement-breakpoint
CREATE INDEX "takedowns_status_idx" ON "takedowns" USING btree ("status","received_at" desc);--> statement-breakpoint
CREATE INDEX "takedowns_skill_idx" ON "takedowns" USING btree ("skill_id");--> statement-breakpoint

-- Tenant isolation for `takedowns` (Doc 3 C4, migration 0002).
--
-- In the same migration as the CREATE TABLE, per the standing rule: RLS defaults to deny,
-- so a new table without a policy is invisible to `app_runtime` rather than merely
-- unprotected — the feature looks broken instead of leaky, and the fix arrives a deploy
-- late.
--
-- Takedowns against the public corpus carry `org_id IS NULL`, which the sync pipeline must
-- be able to read with no session: the block is checked before a fetch, in background work
-- that has no org to declare.
--
-- This policy is a backstop, not the access control. A takedown row holds a requester's
-- name and email, and nothing about `org_id IS NULL` makes those publishable — the DAL
-- decides that by selecting columns, and the public read path takes grounds and date only.
-- Postgres is here to stop a cross-tenant leak, not to decide what a visitor may read.

ALTER TABLE "takedowns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_scope" ON "takedowns" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
