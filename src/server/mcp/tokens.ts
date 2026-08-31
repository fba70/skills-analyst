import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";

import { db } from "@/server/db";
import { events, mcpTokens } from "@/server/db/schema";
import { withExplicitOrgScope, withOrgScope } from "@/server/dal/scope";

/**
 * MCP access tokens (Doc 2 R8.8).
 *
 * ## Why the free scope needs an account at all
 *
 * R8.1 says the registry is readable without one, and that still holds — the web pages, the
 * download route and every trust surface remain anonymous. What changed is the *machine*
 * channel, and the reason is the one the limiter could not solve: an anonymous MCP caller
 * has no identity to attribute a quota to, so the only handle is an IP. An IP is shared by
 * everyone behind one NAT and rotated by anyone who cares, which bounds accidents and
 * nothing else.
 *
 * A free account is the smallest thing that turns the limit into a real one. It is free, it
 * gates nothing a person can read in a browser, and the token it issues is revocable — so
 * this is a *quota identity*, not a paywall. RC.1's rule that trust surfaces cannot be
 * gated is unaffected: every verdict this endpoint returns is on a public page anyone can
 * read without signing in.
 *
 * ## The token is not a session
 *
 * Different secret, different table, different blast radius. A leaked session is an account;
 * a leaked token here reads the public corpus through a rate-limited endpoint and is revoked
 * without signing anyone out.
 */

const PREFIX = "sf_mcp_";
/** 32 bytes ≈ 256 bits of entropy. Guessing is not an attack anyone runs against this. */
const SECRET_BYTES = 32;

export type IssuedToken = {
  id: string;
  name: string;
  prefix: string;
  /** The only time the full token exists. Never stored, never recoverable. */
  token: string;
};

export type TokenSummary = {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a token for the caller's active organisation.
 *
 * The plaintext is returned exactly once and is not written anywhere — not to the row, not
 * to the audit event. The event records that a token was created and by whom, which is the
 * part worth keeping; putting the secret in an append-only log would make the log the thing
 * worth stealing.
 */
export async function createToken(
  name: string,
  actor: { userId: string; email: string; organizationId: string },
): Promise<IssuedToken> {
  const token = `${PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  const prefix = token.slice(0, PREFIX.length + 8);
  const label = name.trim().slice(0, 60) || "unnamed";

  const row = await withExplicitOrgScope(actor.organizationId, async (tx) => {
    const [created] = await tx
      .insert(mcpTokens)
      .values({
        orgId: actor.organizationId,
        createdBy: actor.userId,
        name: label,
        tokenHash: hashToken(token),
        prefix,
      })
      .returning({ id: mcpTokens.id });

    await tx.insert(events).values({
      orgId: actor.organizationId,
      actorType: "user",
      actorId: actor.userId,
      kind: "mcp-token.created",
      subjectType: "mcp_token",
      subjectId: created.id,
      reason: `MCP token "${label}" created`,
      payload: { prefix, by: actor.email },
    });

    return created;
  });

  return { id: row.id, name: label, prefix, token };
}

/** The caller's own workspace tokens. Scoped in the query as well as by RLS. */
export async function listTokens(): Promise<TokenSummary[]> {
  return withOrgScope((tx) =>
    tx
      .select({
        id: mcpTokens.id,
        name: mcpTokens.name,
        prefix: mcpTokens.prefix,
        createdAt: mcpTokens.createdAt,
        lastUsedAt: mcpTokens.lastUsedAt,
        revokedAt: mcpTokens.revokedAt,
      })
      .from(mcpTokens)
      .orderBy(desc(mcpTokens.createdAt))
      .limit(50),
  );
}

/** Revocation is an update, never a delete — see the schema note. */
export async function revokeToken(
  id: string,
  actor: { userId: string; email: string; organizationId: string },
): Promise<boolean> {
  return withExplicitOrgScope(actor.organizationId, async (tx) => {
    const [updated] = await tx
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpTokens.id, id), isNull(mcpTokens.revokedAt)))
      .returning({ id: mcpTokens.id, prefix: mcpTokens.prefix });

    if (!updated) return false;

    await tx.insert(events).values({
      orgId: actor.organizationId,
      actorType: "user",
      actorId: actor.userId,
      kind: "mcp-token.revoked",
      subjectType: "mcp_token",
      subjectId: updated.id,
      reason: `MCP token ${updated.prefix}… revoked`,
      payload: { by: actor.email },
    });

    return true;
  });
}

export type TokenPrincipal = {
  tokenId: string;
  organizationId: string;
  /** What the limiter counts against — a real identity, unlike an IP. */
  rateKey: string;
};

/**
 * Resolves a bearer token to a principal, or null.
 *
 * Read with a plain handle rather than through a scope helper, and that is the one place in
 * this codebase where an unscoped read is correct: the lookup *is* how the organisation is
 * discovered, so there is no org to declare yet. `mcp_tokens` has an open SELECT policy for
 * exactly this call, and what makes it safe is the column list — hashes and prefixes, never
 * a usable credential.
 *
 * The comparison is on `sha256(token)` through a unique index, so it is one index probe and
 * the plaintext never touches a query. A revoked token fails the `isNull` predicate rather
 * than being handled separately, which means revocation is immediate: there is no cache to
 * expire and no session to outlive it.
 */
export async function resolveToken(token: string | undefined): Promise<TokenPrincipal | null> {
  if (!token || !token.startsWith(PREFIX)) return null;

  const [row] = await db
    .select({ id: mcpTokens.id, orgId: mcpTokens.orgId })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hashToken(token)), isNull(mcpTokens.revokedAt)))
    .limit(1);

  if (!row) return null;
  return { tokenId: row.id, organizationId: row.orgId, rateKey: `token:${row.id}` };
}

/**
 * Records that a token was used, at most once a minute per token.
 *
 * A write on every request would double the cost of the cheapest call, for a column read
 * only by a person deciding whether a token is still needed. The `lastUsedAt` predicate
 * makes the statement a no-op for the rest of the minute, so a busy token costs one extra
 * write a minute rather than one per call.
 *
 * **Scoped, and it has to be.** `mcp_tokens` has an org-scoped UPDATE policy, so an
 * unscoped update here would be refused by RLS *silently* — the update would report zero
 * rows and `lastUsedAt` would stay null for ever, on a column whose whole purpose is
 * answering "is this credential still in use". That is the same failure that once made
 * `recordUsage` write nothing and `validatePending` validate nothing: a write that RLS
 * rejects looks exactly like a write that had nothing to do.
 */
export async function touchToken(principal: TokenPrincipal): Promise<void> {
  const cutoff = new Date(Date.now() - 60_000);
  try {
    await withExplicitOrgScope(principal.organizationId, (tx) =>
      tx
        .update(mcpTokens)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(mcpTokens.id, principal.tokenId),
            or(isNull(mcpTokens.lastUsedAt), lt(mcpTokens.lastUsedAt, cutoff)),
          ),
        ),
    );
  } catch {
    // Never fail a request over bookkeeping.
  }
}
