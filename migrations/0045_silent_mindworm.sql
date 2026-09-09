CREATE TABLE "shared_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_blocks" ADD COLUMN "shared_block_id" uuid;--> statement-breakpoint
ALTER TABLE "draft_blocks" ADD COLUMN "shared_block_version" integer;--> statement-breakpoint
ALTER TABLE "shared_blocks" ADD CONSTRAINT "shared_blocks_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_blocks" ADD CONSTRAINT "shared_blocks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_blocks_name_uq" ON "shared_blocks" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "shared_blocks_org_idx" ON "shared_blocks" USING btree ("org_id","retired_at");--> statement-breakpoint
ALTER TABLE "draft_blocks" ADD CONSTRAINT "draft_blocks_shared_block_id_shared_blocks_id_fk" FOREIGN KEY ("shared_block_id") REFERENCES "public"."shared_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "org_scope" ON "shared_blocks" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));