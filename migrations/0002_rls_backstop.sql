-- Tenant isolation, layer 2: the database backstop (Doc 3 C4).
--
-- Layer 1 is the DAL in src/server/dal/, which resolves the org from the session. This
-- layer holds even when layer 1 has a bug: one forgotten `where org_id = ...` and
-- Postgres refuses the row anyway.
--
-- Three parts, deliberately in one migration because two of them alone are useless:
--   1. a least-privilege runtime role (the owner role carries BYPASSRLS, so policies
--      written without it would silently do nothing)
--   2. policies keyed on `app.org_id`, set per transaction by the DAL
--   3. grants, so the app can still read and write what it should
--
-- The role is created WITHOUT a password on purpose. Passwords do not belong in a file
-- that gets committed; `pnpm db:role-password` sets it from .env afterwards.

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE app_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Neon hands new objects to neondb_owner; let the runtime role reach them.
GRANT USAGE ON SCHEMA public TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
--> statement-breakpoint
-- Future tables too, so a later migration does not silently lock the app out.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
--> statement-breakpoint

-- Org-scoped tables. `org_id IS NULL` is the public corpus: readable by everyone,
-- which is the safe common case and most of the traffic. Anything with an org_id is
-- visible only inside a transaction that has declared that org.
--
-- current_setting(..., true) returns NULL rather than erroring when unset, so a request
-- with no session sees exactly the public corpus and nothing else.

ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "skill_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "verdicts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "capability_surfaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "org_scope" ON "sources" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skills" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_versions" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_signals" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "verdicts" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "capability_surfaces" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "org_scope" ON "events" FOR ALL TO app_runtime
  USING (org_id IS NULL OR org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
