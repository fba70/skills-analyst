import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { member, organization } from "@/server/db/schema";

/**
 * Every user owns one organization from the first login.
 *
 * Tenancy and entitlements hang off organizations (specs/core/03-implementation-spec.md),
 * so a user without one is a user half the app cannot serve. Creating it at sign-up
 * keeps that case out of existence instead of guarding against it everywhere.
 */

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "org";
}

async function claimSlug(preferred: string): Promise<string> {
  const base = slugify(preferred);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const [taken] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function ensurePersonalOrganization(user: {
  id: string;
  name?: string | null;
  email: string;
}): Promise<string> {
  const existing = await findFirstOrganizationId(user.id);
  if (existing) return existing;

  const displayName = user.name?.trim() || user.email.split("@")[0];
  const slug = await claimSlug(user.email.split("@")[0]);
  const organizationId = crypto.randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(organization).values({
      id: organizationId,
      name: `${displayName}'s workspace`,
      slug,
      createdAt: now,
    });
    await tx.insert(member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: user.id,
      role: "owner",
      createdAt: now,
    });
  });

  return organizationId;
}

/** The org a fresh session should start in. */
export async function findFirstOrganizationId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(member.createdAt)
    .limit(1);
  return row?.organizationId ?? null;
}

/** Guards any org-scoped read: is this user actually a member? */
export async function isMemberOf(userId: string, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);
  return Boolean(row);
}
