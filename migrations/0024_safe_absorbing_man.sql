CREATE TABLE "skill_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"extractor_version" text NOT NULL,
	"block_order" smallint NOT NULL,
	"type" text,
	"rule" text,
	"parent_role" text,
	"parent_heading_order" smallint,
	"start_char" integer NOT NULL,
	"end_char" integer NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "marker_path" text;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "block_types" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "block_counts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "block_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_structures" ADD COLUMN "token_estimate" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_blocks" ADD CONSTRAINT "skill_blocks_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_blocks" ADD CONSTRAINT "skill_blocks_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_blocks" ADD CONSTRAINT "skill_blocks_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_blocks_uq" ON "skill_blocks" USING btree ("skill_version_id","extractor_version","block_order");--> statement-breakpoint
CREATE INDEX "skill_blocks_type_idx" ON "skill_blocks" USING btree ("extractor_version","type");--> statement-breakpoint
CREATE INDEX "skill_blocks_skill_idx" ON "skill_blocks" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_structures_blocks_idx" ON "skill_structures" USING gin ("block_types");
