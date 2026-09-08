CREATE TABLE "interview_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"edited_text" text,
	"decided_at" timestamp with time zone,
	"draft_block_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"technique" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "interview_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_order" smallint NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD CONSTRAINT "interview_candidates_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD CONSTRAINT "interview_candidates_session_id_interview_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD CONSTRAINT "interview_candidates_turn_id_interview_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."interview_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_candidates" ADD CONSTRAINT "interview_candidates_draft_block_id_draft_blocks_id_fk" FOREIGN KEY ("draft_block_id") REFERENCES "public"."draft_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_draft_id_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_session_id_interview_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_candidates_session_idx" ON "interview_candidates" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "interview_candidates_decision_idx" ON "interview_candidates" USING btree ("decision","type");--> statement-breakpoint
CREATE INDEX "interview_sessions_draft_idx" ON "interview_sessions" USING btree ("draft_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "interview_turns_uq" ON "interview_turns" USING btree ("session_id","turn_order");--> statement-breakpoint
CREATE POLICY "org_scope" ON "interview_candidates" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_scope" ON "interview_sessions" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "org_scope" ON "interview_turns" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));