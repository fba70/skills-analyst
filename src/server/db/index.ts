import "server-only";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";
import { withRetry } from "./retry";

/**
 * `pg` over TCP to Neon's pooled endpoint — not the HTTP driver.
 *
 * The reason is transactions: ingest atomicity, quarantine state transitions and
 * entitlement writes all need `db.transaction()`, and the RLS backstop needs
 * `SET LOCAL app.org_id`, which only works inside a transaction.
 * See specs/core/03-implementation-spec.md.
 */
function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return withNeonRetry(
    new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    }),
  );
}

/**
 * Retries around the two ways a query reaches Postgres (see `retry.ts` for the rules).
 *
 * Wrapping the pool rather than each call site is what makes this complete: Drizzle sends
 * ordinary statements through `pool.query` and takes a client from `pool.connect` for
 * transactions, so those two methods are every path into the database. Adding a retry at
 * the DAL would have covered the DAL and missed ingest, analytics and every script.
 *
 * The phases are not interchangeable. `connect` may retry anything connection-shaped,
 * because no statement has been sent; `query` may retry only failures that happened while
 * establishing the connection, because anything else could have interrupted a write that
 * already reached the server. That distinction is the whole safety argument, and it is why
 * this is two wrapped methods rather than one generic helper.
 */
function withNeonRetry(pool: Pool): Pool {
  const connect = pool.connect.bind(pool);
  const query = pool.query.bind(pool);

  const log = (phase: string) => (attempt: number, delayMs: number, error: unknown) => {
    // Worth a line: a cold start is normal, a repeated one is a signal, and silence here
    // turns "the database is slow sometimes" into an unfalsifiable claim.
    console.warn(
      `[db] ${phase} retry ${attempt} in ${delayMs}ms — ${(error as Error).message.slice(0, 120)}`,
    );
  };

  pool.connect = function patchedConnect(this: Pool, ...args: unknown[]) {
    // Callback form: `pg` handles the callback itself and never returns a promise, so
    // there is nothing here to retry without changing the contract. Passed straight
    // through rather than wrapped badly.
    if (typeof args[0] === "function") {
      return (connect as (...a: unknown[]) => unknown)(...args);
    }
    return withRetry(() => connect(), { phase: "connect", onRetry: log("connect") });
  } as typeof pool.connect;

  pool.query = function patchedQuery(this: Pool, ...args: unknown[]) {
    if (typeof args[args.length - 1] === "function") {
      return (query as (...a: unknown[]) => unknown)(...args);
    }
    return withRetry(() => (query as (...a: unknown[]) => Promise<unknown>)(...args), {
      phase: "query",
      onRetry: log("query"),
    });
  } as typeof pool.query;

  return pool;
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
