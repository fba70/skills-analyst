import "server-only";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

/**
 * `pg` over TCP to Neon's pooled endpoint — not the HTTP driver.
 *
 * The reason is transactions: ingest atomicity, quarantine state transitions and
 * entitlement writes all need `db.transaction()`, and the RLS backstop needs
 * `SET LOCAL app.org_id`, which only works inside a transaction.
 * See specs/core/03-implementation-spec.md.
 *
 * TODO: wrap queries in exponential backoff with jitter. Neon documents this as
 * required for cold starts, not optional.
 */
function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

// One pool per process. Next.js dev reloads modules on every edit, so the pool is
// parked on globalThis or we leak a pool per keystroke.
const globalForDb = globalThis as unknown as { pool?: Pool };
const pool = globalForDb.pool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
}

// Column names are spelled out in the schema files, so no `casing` inference here.
export const db = drizzle(pool, { schema });
export { schema };
export type Db = typeof db;
