CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"created_by" text,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_hash_uq" ON "mcp_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_org_idx" ON "mcp_tokens" USING btree ("org_id","created_at");--> statement-breakpoint

-- RLS for `mcp_tokens`. This is the second split policy in the schema, and like the first
-- (`builder_signals`) the split is the design rather than an oversight.
--
-- SELECT is open to `app_runtime`. Authenticating an MCP request means looking a token up
-- **before** any organisation is known — that lookup *is* how the org is discovered — so a
-- policy keyed on `app.org_id` would make the one read that matters impossible. What makes
-- this safe is the column list: the table holds `sha256(token)` and an eight-character
-- prefix, never a usable credential, so an open read discloses nothing that can be replayed.
-- Add a column carrying a secret and this policy becomes wrong.
--
-- INSERT and UPDATE are org-scoped: creating and revoking a token are tenant operations and
-- must never cross a workspace boundary. Listing for the UI goes through `withOrgScope`,
-- which applies the same predicate in the query rather than relying on the open read.
--
-- There is no DELETE. A revoked token keeps its row: deleting it frees the name for silent
-- re-creation and erases the fact that a credential existed, which is precisely the question
-- asked after an incident.
ALTER TABLE "mcp_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "read_all" ON "mcp_tokens" FOR SELECT TO app_runtime
  USING (true);--> statement-breakpoint
CREATE POLICY "write_own_org" ON "mcp_tokens" FOR INSERT TO app_runtime
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "update_own_org" ON "mcp_tokens" FOR UPDATE TO app_runtime
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mcp_tokens" TO app_runtime;
