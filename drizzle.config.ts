import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Migrations run on Neon's **direct (unpooled)** endpoint, not the pooled one the app
 * uses: the pooler cannot run `CREATE INDEX CONCURRENTLY`, and this schema will need it
 * (partial unique index on content_hash, GIN on the FTS vector, HNSW on embeddings).
 * Falls back to DATABASE_URL so a fresh clone still works.
 */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error("Set DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL");
}

/**
 * `drizzle-kit push` is banned in this repo — it proposes destructive phantom drops on
 * partial and expression indexes, and this schema has both. The database changes only
 * through committed files in ./migrations:
 *   db:generate -> read the SQL -> db:migrate -> commit.
 * .claude/hooks/migrations-only.sh blocks push and hand-typed DDL.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema",
  out: "./migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
