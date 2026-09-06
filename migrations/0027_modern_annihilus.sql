CREATE TYPE "public"."org_plan" AS ENUM('free', 'pro', 'team');--> statement-breakpoint
CREATE TABLE "org_entitlements" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"plan" "org_plan" DEFAULT 'free' NOT NULL,
	"note" text,
	"granted_by" text,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD CONSTRAINT "org_entitlements_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD CONSTRAINT "org_entitlements_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "read_all" ON "org_entitlements" AS PERMISSIVE FOR SELECT TO "app_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "org_write" ON "org_entitlements" AS PERMISSIVE FOR INSERT TO "app_runtime" WITH CHECK (organization_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_update" ON "org_entitlements" AS PERMISSIVE FOR UPDATE TO "app_runtime" USING (organization_id = current_setting('app.org_id', true)) WITH CHECK (organization_id = current_setting('app.org_id', true));