CREATE TABLE "builder_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"skill_id" uuid,
	"archetype_category" text NOT NULL,
	"archetype_version" integer,
	"section_role" text NOT NULL,
	"offered" boolean NOT NULL,
	"authored" boolean NOT NULL,
	"survived" boolean NOT NULL,
	"first_pass_valid" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "scaffold_sections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_signals" ADD CONSTRAINT "builder_signals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_signals" ADD CONSTRAINT "builder_signals_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_signals" ADD CONSTRAINT "builder_signals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_signals_draft_role_uq" ON "builder_signals" USING btree ("draft_id","section_role");--> statement-breakpoint
CREATE INDEX "builder_signals_category_idx" ON "builder_signals" USING btree ("archetype_category","section_role");--> statement-breakpoint
CREATE INDEX "builder_signals_org_idx" ON "builder_signals" USING btree ("org_id","created_at");--> statement-breakpoint

-- RLS for `builder_signals` — deliberately NOT the org_scope policy used elsewhere.
--
-- Every other table in this schema reads and writes under one org-scope rule. This one
-- splits them, and the split is the whole point of R6.2: the value of creation telemetry is
-- that it aggregates *across* organisations. A read policy scoped to `app.org_id` would let
-- an archetype learn only from a single tenant at a time, which is both useless and exactly
-- the shape RC.5 forbids.
--
-- So: writes are org-scoped, reads are not.
--
--   * WRITE (insert/update/delete) requires `org_id = current_setting('app.org_id')`, so no
--     organisation can forge, alter or delete another's signals. That is what makes R6.5's
--     per-identity deduplication meaningful — the unique index stops double-counting, and
--     this stops impersonation.
--
--   * READ is open to `app_runtime`, because the miner runs as background work with no
--     session and must see every organisation's rows to aggregate them at all.
--
-- Read access is safe *because of what this table is allowed to contain*: booleans, a
-- category, and a section role from our own closed vocabulary. No skill text, no names, no
-- author input. The privacy guarantee lives in the column list, not in the read policy —
-- and the minimum-distinct-organisations floor applied at aggregation is what stops a
-- published aggregate describing one tenant. If a column carrying tenant content is ever
-- added here, this policy becomes wrong and must change with it.

ALTER TABLE "builder_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "read_all" ON "builder_signals" FOR SELECT TO app_runtime
  USING (true);
--> statement-breakpoint
CREATE POLICY "write_own_org" ON "builder_signals" FOR INSERT TO app_runtime
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "update_own_org" ON "builder_signals" FOR UPDATE TO app_runtime
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
CREATE POLICY "delete_own_org" ON "builder_signals" FOR DELETE TO app_runtime
  USING (org_id = current_setting('app.org_id', true));
