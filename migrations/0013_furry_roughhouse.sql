ALTER TYPE "public"."license_source" ADD VALUE 'authored';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'builder';--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "published_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_published_skill_id_skills_id_fk" FOREIGN KEY ("published_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;