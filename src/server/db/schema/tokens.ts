import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "./auth";

/**
 * MCP access tokens (Doc 2 R8.8).
 *
 * ## Ours, not Better Auth's
 *
 * Better Auth 1.7.2 ships no API-key plugin, and the version is pinned deliberately — core
 * and plugins must move together or two copies of `@better-auth/core` crash at startup. So
 * this is a small table of our own, which is the better answer anyway: an MCP token must
 * **not** be a session. A leaked session is an account; a leaked token here reads the public
 * corpus through a rate-limited endpoint and can be revoked without signing anybody out.
 *
 * ## Only the hash is stored
 *
 * The token is shown once, at creation, and never again — we keep `sha256(token)` and an
 * eight-character prefix. The prefix is what the UI lists, so an operator can tell two
 * tokens apart without the table holding anything that could be replayed. A token column we
 * could read back would make this table worth stealing.
 *
 * ## Revoked, never deleted
 *
 * `revokedAt` is set; the row stays. A deleted row frees its name for silent re-creation and
 * erases the fact that a credential once existed — which is the question actually asked
 * after an incident. Same reasoning as `platform_settings` having no DELETE.
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * NOT NULL, unlike the corpus tables. There is no such thing as a public token: a
     * credential with no owner is one nobody can revoke and nobody is accountable for.
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Who created it. Kept when the user is deleted so the audit trail survives them. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** The operator's own label, e.g. "laptop", "ci". Not unique — people reuse names. */
    name: text("name").notNull(),
    /** `sha256(token)`, hex. The only copy of the secret that exists after creation. */
    tokenHash: text("token_hash").notNull(),
    /** First eight characters, for display. Never enough to authenticate with. */
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Best-effort, and deliberately not written on every call: one extra write per request
     * on the hot path to power a column nobody reads in real time is a poor trade. The
     * limiter's counters already show live traffic; this answers "is this token still used".
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mcp_tokens_hash_uq").on(t.tokenHash),
    index("mcp_tokens_org_idx").on(t.orgId, t.createdAt),
  ],
);
