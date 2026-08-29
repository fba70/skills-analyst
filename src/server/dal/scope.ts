import "server-only";

import { sql } from "drizzle-orm";

import { db, type Db } from "@/server/db";
import { getSession } from "@/server/dal/session";

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
