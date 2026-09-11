CREATE TABLE "tool_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"current_version" text,
	"released_at" timestamp with time zone,
	"status" text NOT NULL,
	"status_code" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_versions_uq" ON "tool_versions" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "tool_versions_due_idx" ON "tool_versions" USING btree ("checked_at");--> statement-breakpoint
CREATE POLICY "public_read" ON "tool_versions" AS PERMISSIVE FOR ALL TO "app_runtime" USING (true) WITH CHECK (true);