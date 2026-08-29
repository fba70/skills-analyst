import "server-only";

import { and, eq } from "drizzle-orm";

import { member, organization } from "@/server/db/schema";
import { withOrgScope } from "@/server/dal/scope";
import { requireActiveOrganizationId, requireSession } from "@/server/dal/session";

export type ActiveOrganization = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

/**
 * The org for the current session, with the caller's role in it.
 *
 * Both the org id and the user id come from the session, never from an argument — that
 * is the whole point of the DAL boundary. The join on `member` doubles as the
 * membership check: a session pointing at an org the user does not belong to returns
 * null rather than data.
 */
export async function getActiveOrganization(): Promise<ActiveOrganization | null> {
  const session = await requireSession();
  const organizationId = await requireActiveOrganizationId();

  const [row] = await withOrgScope((tx) =>
    tx
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
      })
      .from(organization)
      .innerJoin(
        member,
        and(
          eq(member.organizationId, organization.id),
          eq(member.userId, session.user.id),
        ),
      )
      .where(eq(organization.id, organizationId))
      .limit(1),
  );

  return row ?? null;
}
