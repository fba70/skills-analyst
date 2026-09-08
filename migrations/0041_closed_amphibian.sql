CREATE TABLE "category_maintainers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"axis" "category_axis" NOT NULL,
	"category" text NOT NULL,
	"note" text,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "category_maintainers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_endorsements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"axis" "category_axis" NOT NULL,
	"category" text NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "skill_endorsements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category_maintainers" ADD CONSTRAINT "category_maintainers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_maintainers" ADD CONSTRAINT "category_maintainers_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_maintainers" ADD CONSTRAINT "category_maintainers_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_endorsements" ADD CONSTRAINT "skill_endorsements_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_endorsements" ADD CONSTRAINT "skill_endorsements_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_endorsements" ADD CONSTRAINT "skill_endorsements_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_endorsements" ADD CONSTRAINT "skill_endorsements_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_maintainers_uq" ON "category_maintainers" USING btree ("user_id","axis","category");--> statement-breakpoint
CREATE INDEX "category_maintainers_category_idx" ON "category_maintainers" USING btree ("axis","category","revoked_at");--> statement-breakpoint
CREATE INDEX "category_maintainers_user_idx" ON "category_maintainers" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_endorsements_uq" ON "skill_endorsements" USING btree ("skill_id","user_id");--> statement-breakpoint
CREATE INDEX "skill_endorsements_skill_idx" ON "skill_endorsements" USING btree ("skill_id","withdrawn_at");--> statement-breakpoint
CREATE INDEX "skill_endorsements_user_idx" ON "skill_endorsements" USING btree ("user_id","at");--> statement-breakpoint
CREATE POLICY "all_access" ON "category_maintainers" AS PERMISSIVE FOR ALL TO "app_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_endorsements" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));