CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- RLS for `platform_settings`.
--
-- READ is open to `app_runtime`: the cron route runs with no session and must be able to
-- ask whether it is switched on. A read policy keyed on `app.org_id` would make the
-- scheduler unable to read its own configuration.
--
-- WRITE is refused to the application entirely — there is no INSERT or UPDATE policy, so
-- `app_runtime` cannot write here at all.
--
-- That is deliberate and it is *not* how the admin UI writes. Settings changes go through
-- a server action that re-checks `requireAdmin()` and then writes through the same
-- `app_runtime` role, so this policy would block them. It is therefore added **with** an
-- INSERT/UPDATE policy below; what is withheld is DELETE. A setting is never removed, only
-- changed: deleting a row silently restores a default, which is the one state transition an
-- operator would not expect and could not see in the audit log.

ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "read_all" ON "platform_settings" FOR SELECT TO app_runtime
  USING (true);
--> statement-breakpoint
CREATE POLICY "write_all" ON "platform_settings" FOR INSERT TO app_runtime
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "update_all" ON "platform_settings" FOR UPDATE TO app_runtime
  USING (true) WITH CHECK (true);
