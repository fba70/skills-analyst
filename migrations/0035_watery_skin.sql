ALTER TABLE "eval_runs" ADD COLUMN "with_skill" boolean;--> statement-breakpoint
CREATE INDEX "eval_runs_matrix_idx" ON "eval_runs" USING btree ("eval_id","with_skill","content_hash");