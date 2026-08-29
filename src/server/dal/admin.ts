import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { events, organization, user } from "@/server/db/schema";
import { ADMIN_ROLE } from "@/server/auth/roles";
import { pageWindow, type Paged } from "@/server/dal/paging";
import { getSession, requireSession } from "@/server/dal/session";

/**
 * Platform administration.
 *
 * A **system admin** is not an organisation role. Organisation roles (owner, member) say
 * what someone may do inside their own tenant; this says what someone may do to the
 * platform — see every user, run ingestion, change policy. Conflating the two would mean
 * every workspace owner could reach the crawler.
 *
 * The role lives on `user.role`, which is the field Better Auth's admin plugin already
 * checks, so the two agree rather than competing.
 *
 * Every function here re-checks the caller. That is not belt-and-braces: server actions
 * are POSTs that can be invoked directly, so a guard in the page is a guard on the *view*,
 * not on the operation.
 */

export { ADMIN_ROLE, bootstrapAdminEmails, isBootstrapAdmin } from "@/server/auth/roles";

export async function isAdmin(): Promise<boolean> {
  const session = await getSession();
  const role = (session?.user as { role?: string | null } | undefined)?.role;
  return role === ADMIN_ROLE;
}

/**
 * Throws unless the caller is a system admin.
 *
 * Throws rather than redirects: these guard actions, not pages, and a redirect from an
 * action is a silent no-op that looks like success.
 */
export async function requireAdmin(): Promise<{ userId: string; email: string }> {
  const session = await requireSession();
  const role = (session.user as { role?: string | null }).role;
  if (role !== ADMIN_ROLE) {
    throw new Error("Not authorised: system admin only");
  }
  return { userId: session.user.id, email: session.user.email };
}

export type PlatformUser = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean | null;
  emailVerified: boolean;
  createdAt: Date;
  organizations: number;
};

/** Every user on the platform. Admin-only, and deliberately not org-scoped. */
export async function listPlatformUsers(
  query: { page?: number; pageSize?: number } = {},
): Promise<Paged<PlatformUser>> {
  await requireAdmin();

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(user);
  const window = pageWindow(total, query.page, query.pageSize);

  const items = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      /**
       * Table prefixes spelled out on purpose. Drizzle omits qualification on a
       * single-table select, so `${member.userId} = ${user.id}` renders as
       * `"user_id" = "id"` — and inside the subquery `"id"` binds to `member.id`, not
       * `user.id`. The count silently came back 0 for everyone.
       */
      organizations: sql<number>`(
        select count(*)::int from "member" where "member"."user_id" = "user"."id"
      )`,
    })
    .from(user)
    .orderBy(desc(user.createdAt))
    .limit(window.pageSize)
    .offset(window.offset);

  return { items, total, page: window.page, pageSize: window.pageSize, pageCount: window.pageCount };
}

/** Grants or revokes the system-admin role, with an audit trail. */
export async function setUserRole(userId: string, role: "admin" | "user"): Promise<void> {
  const actor = await requireAdmin();

  if (userId === actor.userId && role === "user") {
    // Locking the last admin out of their own platform is not a decision to make by
    // accident on a dropdown.
    throw new Error("You cannot remove your own admin role");
  }

  await db.transaction(async (tx) => {
    await tx.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, userId));
    await tx.insert(events).values({
      actorType: "user",
      actorId: actor.userId,
      kind: "user.role_changed",
      subjectType: "user",
      subjectId: userId,
      reason: `role set to ${role}`,
      payload: { role, by: actor.email },
    });
  });
}

export async function setUserBanned(userId: string, banned: boolean): Promise<void> {
  const actor = await requireAdmin();
  if (userId === actor.userId) {
    throw new Error("You cannot ban yourself");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({ banned, banReason: banned ? "Banned by administrator" : null, updatedAt: new Date() })
      .where(eq(user.id, userId));
    await tx.insert(events).values({
      actorType: "user",
      actorId: actor.userId,
      kind: banned ? "user.banned" : "user.unbanned",
      subjectType: "user",
      subjectId: userId,
      payload: { by: actor.email },
    });
  });
}

/** Headline counts for the settings overview. */
export async function platformCounts() {
  await requireAdmin();

  const [row] = await db
    .select({
      users: sql<number>`(select count(*)::int from ${user})`,
      admins: sql<number>`(select count(*)::int from ${user} where ${user.role} = ${ADMIN_ROLE})`,
      organizations: sql<number>`(select count(*)::int from ${organization})`,
    })
    .from(user)
    .limit(1);

  return row ?? { users: 0, admins: 0, organizations: 0 };
}
