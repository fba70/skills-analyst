CREATE TABLE "pipeline_heartbeat" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"stage" text,
	"detail" text,
	"items_done" integer,
	"items_total" integer,
	"pass_started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pid" integer
);
--> statement-breakpoint

-- RLS for `pipeline_heartbeat`.
--
-- SELECT, INSERT and UPDATE are open to `app_runtime`: the pipeline runs with no session and
-- must be able to write its own position, and every operator surface must be able to read it.
-- A policy keyed on `app.org_id` would make the one writer unable to write.
--
-- DELETE is granted, unlike on `platform_settings` and `llm_usage`. Those withhold it because
-- they are records of decisions and of money; this is a single row of ephemeral position that
-- is overwritten every few seconds and carries no history. Clearing it is how you say "no
-- pipeline is running", which is a legitimate thing to assert after a crash.
ALTER TABLE "pipeline_heartbeat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "read_all" ON "pipeline_heartbeat" FOR SELECT TO app_runtime USING (true);--> statement-breakpoint
CREATE POLICY "write_all" ON "pipeline_heartbeat" FOR INSERT TO app_runtime WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "update_all" ON "pipeline_heartbeat" FOR UPDATE TO app_runtime USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "clear_all" ON "pipeline_heartbeat" FOR DELETE TO app_runtime USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipeline_heartbeat" TO app_runtime;
