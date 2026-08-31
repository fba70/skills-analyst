import "server-only";

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";
import { guardClient } from "./client-guard";
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
      /**
       * TCP keepalive, because `pg` defaults it off and our workload is the worst case.
       *
       * The pipeline spends minutes inside a single GitHub fetch with no database traffic
       * at all. A NAT or firewall on the path sees a silent socket and drops it, and the
       * next read fails with `ETIMEDOUT` — which is precisely the crash this is a response
       * to. Keepalive probes keep the connection observably alive through those gaps.
       *
       * The delay is short relative to the idle timeout above: a connection should either
       * be proven alive or be returned to the pool and closed, never sit unproven.
       */
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
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

  /**
   * Idle-client errors, which `pg-pool` re-emits on the pool.
   *
   * Required, not optional: `EventEmitter.emit("error")` throws when nothing is listening,
   * so a pool with no handler turns any network blip on an idle connection into a process
   * exit. `pg-pool` has already removed the client by the time this runs — there is
   * nothing to repair, only something to record.
   */
  pool.on("error", (error) => {
    console.warn(`[db] idle client dropped — ${error.message.slice(0, 160)}`);
  });

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
    /**
     * Guarded, because this is the path `pg` leaves uncovered.
     *
     * `pool.query` attaches its own `error` listener around the query; `pool.connect()`
     * attaches nothing, and Drizzle uses it for every `db.transaction()`. See
     * `client-guard.ts` — an unhandled `error` event here is a process exit, and it took
     * out a 60-pass ingestion run at pass 26.
     */
    return withRetry(() => connect(), {
      phase: "connect",
      onRetry: log("connect"),
    }).then((client) =>
      guardClient(client, {
        onError: (error) =>
          console.warn(
            `[db] connection lost while checked out — ${error.message.slice(0, 160)}`,
          ),
      }),
    );
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
