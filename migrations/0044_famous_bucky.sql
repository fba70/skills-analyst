CREATE TABLE "distill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"created_by" text,
	"label" text,
	"distill_version" text NOT NULL,
	"model" text,
	"turns_read" smallint DEFAULT 0 NOT NULL,
	"human_turns" smallint DEFAULT 0 NOT NULL,
	"tool_results_dropped" integer DEFAULT 0 NOT NULL,
	"windows_found" smallint DEFAULT 0 NOT NULL,
	"windows_sent" smallint DEFAULT 0 NOT NULL,
	"redactions" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distill_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_candidates" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_candidates" ALTER COLUMN "turn_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD COLUMN "distill_run_id" uuid;--> statement-breakpoint
ALTER TABLE "distill_runs" ADD CONSTRAINT "distill_runs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distill_runs" ADD CONSTRAINT "distill_runs_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distill_runs" ADD CONSTRAINT "distill_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "distill_runs_draft_idx" ON "distill_runs" USING btree ("draft_id","created_at");--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD CONSTRAINT "interview_candidates_distill_run_id_distill_runs_id_fk" FOREIGN KEY ("distill_run_id") REFERENCES "public"."distill_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_candidates_distill_idx" ON "interview_candidates" USING btree ("distill_run_id","created_at");--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD CONSTRAINT "interview_candidates_one_origin" CHECK ((session_id is null) <> (distill_run_id is null));--> statement-breakpoint
CREATE POLICY "org_scope" ON "distill_runs" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));