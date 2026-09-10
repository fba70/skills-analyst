CREATE TABLE "skill_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_watches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_watches" ADD CONSTRAINT "skill_watches_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_watches_uq" ON "skill_watches" USING btree ("user_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "skill_watches_user_idx" ON "skill_watches" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "all_access" ON "skill_watches" AS PERMISSIVE FOR ALL TO "app_runtime" USING (true) WITH CHECK (true);