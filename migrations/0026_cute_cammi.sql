CREATE TYPE "public"."lifecycle_declaration" AS ENUM('deprecated', 'superseded');--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "lifecycle_declaration" "lifecycle_declaration";--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "superseded_by_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "lifecycle_note" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "review_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "lifecycle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;