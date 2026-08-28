import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth, type Session } from "@/server/auth";

/**
 * The auth boundary.
 *
 * Every server component, server action and DAL entry point resolves the session
 * here. `src/proxy.ts` only redirects early for a nicer feel — it is never the
 * boundary, because server actions are POSTs that can slip past a matcher.
 */

/** De-duplicated per request, so a page with ten server components hits auth once. */
export const getSession = cache(async (): Promise<Session | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ?? null;
});

/** Use in any protected server component. Redirects instead of returning null. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }
  return session;
}

/**
 * The org every scoped query must be keyed on. Read it from the session — never from
 * a client-supplied parameter.
 */
export async function requireActiveOrganizationId(): Promise<string> {
  const session = await requireSession();
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new Error("Session has no active organization");
  }
  return organizationId;
}
