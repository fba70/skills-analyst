"use server";

import { revalidatePath } from "next/cache";

import { requireActiveOrganizationId, requireSession } from "@/server/dal/session";
import { createToken, revokeToken, type IssuedToken } from "@/server/mcp/tokens";

/**
 * MCP token actions (Doc 2 R8.8).
 *
 * A server action is a POST endpoint, so the page guard protects the view and not the
 * operation: `requireSession()` and `requireActiveOrganizationId()` are resolved here, where
 * the write happens, exactly as the settings actions re-check `requireAdmin()`.
 *
 * No admin check — an MCP token is a workspace credential, not a platform one. Any signed-in
 * member may mint one for their own organisation, and RLS refuses a write to anyone else's.
 */

export type TokenResult =
  | { ok: true; issued: IssuedToken }
  | { ok: false; message: string };

export async function createTokenAction(name: string): Promise<TokenResult> {
  try {
    const session = await requireSession();
    const organizationId = await requireActiveOrganizationId();
    const issued = await createToken(name, {
      userId: session.user.id,
      email: session.user.email,
      organizationId,
    });
    revalidatePath("/account");
    return { ok: true, issued };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not create a token." };
  }
}

export async function revokeTokenAction(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const session = await requireSession();
    const organizationId = await requireActiveOrganizationId();
    const revoked = await revokeToken(id, {
      userId: session.user.id,
      email: session.user.email,
      organizationId,
    });
    revalidatePath("/account");
    return revoked
      ? { ok: true, message: "Token revoked. It stops working immediately." }
      : { ok: false, message: "That token was already revoked." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not revoke." };
  }
}
