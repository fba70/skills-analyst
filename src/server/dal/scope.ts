import "server-only";

import { sql } from "drizzle-orm";

import { db, type Db } from "@/server/db";

/**
 * Runs a query inside a transaction that has declared which org is asking.
 *
 * This is the other half of the RLS backstop: migration 0002 wrote the policies, and
 * `SET LOCAL app.org_id` is what feeds them. It only works inside a transaction, which
 * is why the stack uses `pg` over TCP rather than Neon's HTTP driver.
 *
 * Every org-scoped read and write goes through here. Forgetting a `where org_id = ...`
 * inside the callback is then survivable — Postgres filters the row anyway.
 *
 * With no session, nothing is set and the caller sees exactly the public corpus
 * (`org_id IS NULL`), which is the common case for the registry.
 */
export async function withOrgScope<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  /**
   * Imported lazily so this module stays loadable outside a request.
   *
   * `dal/session` reaches `next/navigation` for `redirect`, which pulls in React's client
   * runtime and throws on import in a plain node process. At module scope that cost was
   * paid by *everything* importing this file — including `withPublicScope`, which needs no
   * session at all — so any verification script touching public-corpus reads died on an
   * import it never used.
   */
  const { getSession } = await import("@/server/dal/session");
  const session = await getSession();
  const organizationId = session?.session.activeOrganizationId ?? null;
  return runScoped(organizationId, fn);
}

/**
 * Public-corpus only, no session lookup. Use for anonymous pages where a session read
 * would be wasted work.
 */
export async function withPublicScope<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return runScoped(null, fn);
}

/**
 * Explicit org, for background work that has no session — a sync worker acting for a
 * tenant. `server-only` and never reachable from a `"use server"` action, so a client
 * cannot choose the org it reads as.
 */
export async function withExplicitOrgScope<T>(
  organizationId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return runScoped(organizationId, fn);
}

async function runScoped<T>(
  organizationId: string | null,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (organizationId) {
      // `true` = local to this transaction, so a pooled connection cannot leak the
      // setting to the next request that borrows it.
      await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true)`);
    }
    return fn(tx as unknown as Db);
  });
}
