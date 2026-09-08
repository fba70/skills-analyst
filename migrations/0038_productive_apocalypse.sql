CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query" text NOT NULL,
	"result_count" integer NOT NULL,
	"channel" text NOT NULL,
	"day" date NOT NULL,
	"caller_digest" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_queries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "search_queries_uq" ON "search_queries" USING btree ("query","channel","day","caller_digest");--> statement-breakpoint
CREATE INDEX "search_queries_demand_idx" ON "search_queries" USING btree ("query","result_count");--> statement-breakpoint
CREATE INDEX "search_queries_at_idx" ON "search_queries" USING btree ("at" desc);--> statement-breakpoint
CREATE POLICY "all_access" ON "search_queries" AS PERMISSIVE FOR ALL TO "app_runtime" USING (true) WITH CHECK (true);