ALTER TYPE "public"."llm_purpose" ADD VALUE 'eval' BEFORE 'validation';--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"eval_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"detail" text,
	"confidence" smallint,
	"model" text NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_evals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid,
	"skill_id" uuid,
	"kind" text NOT NULL,
	"prompt" text NOT NULL,
	"expectation" text,
	"source" text DEFAULT 'authored' NOT NULL,
	"source_candidate_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_evals_one_parent" CHECK ((draft_id is null) <> (skill_id is null))
);
--> statement-breakpoint
ALTER TABLE "skill_evals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD COLUMN "eval_prompt" text;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD COLUMN "eval_expectation" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_id_skill_evals_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."skill_evals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evals" ADD CONSTRAINT "skill_evals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evals" ADD CONSTRAINT "skill_evals_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evals" ADD CONSTRAINT "skill_evals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evals" ADD CONSTRAINT "skill_evals_source_candidate_id_interview_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."interview_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evals" ADD CONSTRAINT "skill_evals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_runs_eval_idx" ON "eval_runs" USING btree ("eval_id","run_at" desc);--> statement-breakpoint
CREATE INDEX "skill_evals_draft_idx" ON "skill_evals" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_evals_skill_idx" ON "skill_evals" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE POLICY "org_read" ON "eval_runs" AS PERMISSIVE FOR SELECT TO "app_runtime" USING (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_append" ON "eval_runs" AS PERMISSIVE FOR INSERT TO "app_runtime" WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_evals" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));