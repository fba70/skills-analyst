CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text NOT NULL,
	"scope" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_bucket_key_scope_pk" PRIMARY KEY("bucket_key","scope")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_window_idx" ON "rate_limit_buckets" USING btree ("window_start");--> statement-breakpoint

-- RLS for `rate_limit_buckets`.
--
-- The application needs SELECT, INSERT and UPDATE: the limiter runs with no session, on an
-- anonymous request, and must be able to read and increment its own counter. A policy keyed
-- on `app.org_id` would make the limiter unable to count the exact callers it exists to
-- count — the ones with no org at all.
--
-- DELETE is granted here, unlike on `platform_settings` and `llm_usage`, and the difference
-- is the point: those are records of decisions and of money, where an application that can
-- erase its own history has none. A rate-limit counter is ephemeral state whose meaning
-- expires with its window, and pruning callers that have gone away is maintenance. The
-- audit trail for rate limiting is in `events`, which records the *policy* changes.
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "read_all" ON "rate_limit_buckets" FOR SELECT TO app_runtime
  USING (true);--> statement-breakpoint
CREATE POLICY "write_all" ON "rate_limit_buckets" FOR INSERT TO app_runtime
  WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "update_all" ON "rate_limit_buckets" FOR UPDATE TO app_runtime
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "prune_all" ON "rate_limit_buckets" FOR DELETE TO app_runtime
  USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_buckets" TO app_runtime;
