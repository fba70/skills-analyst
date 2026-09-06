-- `CREATE EXTENSION` is hand-written, and it is the one thing in this file that is.
--
-- The standing convention (2026-09-06) is that a migration is drizzle-kit output and nothing
-- else. An extension is not expressible in a Drizzle schema — the same documented exception
-- migration 0017 took for `pg_trgm`, with the same constraint: it must sit **above** the
-- table below, because `vector(1536)` does not exist as a type until the extension does.
--
-- pgvector 0.8.6 is available on this Neon instance and not installed; checked before
-- writing this rather than assumed, since a migration whose first execution is in production
-- is a migration reviewed only by reading.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TYPE "public"."llm_purpose" ADD VALUE 'corpus_embedding';--> statement-breakpoint
CREATE TABLE "skill_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"embedder_version" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_embeddings" ADD CONSTRAINT "skill_embeddings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_embeddings" ADD CONSTRAINT "skill_embeddings_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_embeddings" ADD CONSTRAINT "skill_embeddings_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_embeddings_uq" ON "skill_embeddings" USING btree ("skill_version_id","embedder_version");--> statement-breakpoint
CREATE INDEX "skill_embeddings_skill_idx" ON "skill_embeddings" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_embeddings_hnsw_idx" ON "skill_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE POLICY "org_scope" ON "skill_embeddings" AS PERMISSIVE FOR ALL TO "app_runtime" USING (org_id is null or org_id = current_setting('app.org_id', true)) WITH CHECK (org_id is null or org_id = current_setting('app.org_id', true));