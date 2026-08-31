CREATE TYPE "public"."llm_purpose" AS ENUM('builder', 'validation', 'corpus_taxonomy', 'corpus_validation');--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"purpose" "llm_purpose" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_org_at_idx" ON "llm_usage" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "llm_usage_purpose_at_idx" ON "llm_usage" USING btree ("purpose","at");--> statement-breakpoint

-- RLS for `llm_usage` — the same split as `builder_signals`, for a different reason.
--
-- WRITE is org-scoped **or platform**: a row either belongs to the organisation making the
-- request, or to nobody (`org_id IS NULL`) because it is corpus work with no customer
-- behind it. No organisation can write a charge against another.
--
-- READ is open to `app_runtime`, because the platform budget is a sum over every row
-- regardless of owner, and background analysis runs with no session to declare. A read
-- policy on `app.org_id` would make the global budget in RC.2 uncomputable.
--
-- Read access is safe because of what the columns are: token counts, a cost, a model name,
-- a purpose, and an opaque subject id. No prompt text, no completion text, no skill
-- content. A ledger that recorded *what was asked* would be a very different table and this
-- policy would be wrong for it.
--
-- The per-org sum that enforces a cap is still scoped by an explicit `where org_id = ...`
-- in the query — RLS is the backstop here, not the filter.

ALTER TABLE "llm_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "read_all" ON "llm_usage" FOR SELECT TO app_runtime
  USING (true);
--> statement-breakpoint
CREATE POLICY "write_own_or_platform" ON "llm_usage" FOR INSERT TO app_runtime
  WITH CHECK (org_id IS NULL OR org_id = current_setting('app.org_id', true));
