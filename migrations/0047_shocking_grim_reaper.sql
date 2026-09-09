CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"customer_id" text,
	"organization_id" text,
	"outcome" text NOT NULL,
	"applied_plan" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD COLUMN "billing_provider" text;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_uq" ON "billing_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_events_org_idx" ON "billing_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_entitlements_billing_customer_uq" ON "org_entitlements" USING btree ("billing_provider","billing_customer_id") WHERE "org_entitlements"."billing_customer_id" is not null;--> statement-breakpoint
CREATE POLICY "all_access" ON "billing_events" AS PERMISSIVE FOR ALL TO "app_runtime" USING (true) WITH CHECK (true);