import { sql } from "drizzle-orm";
import {
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { skills, skillVersions } from "./corpus";
import { categoryAxis } from "./enums";

/**
 * Maintainer groups and endorsement (Doc 6 RK.6, plan step E5).
 *
 * B2 built the negative direction — anybody may report a problem, one admin decides. These two
 * tables are the other half: **named people responsible for a category**, who can work that
 * queue for their own categories and can say a skill is good in a way that carries their name.
 */

/**
 * Who maintains which category.
 *
 * ## Standing is revoked, never deleted
 *
 * `revoked_at` rather than a `delete`, for the reason a rejected flag and a rejected takedown are
 * both kept: the decisions this person made while they held it are in the audit log, and a log
 * pointing at a maintainership that no longer exists in any table is unreadable. It also makes
 * the endorsement join honest — an endorsement counts only while the standing behind it does, and
 * that is a live join against this column rather than a sweep somebody has to remember to run.
 */
export const categoryMaintainers = pgTable(
  "category_maintainers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /**
     * Both axes, because the two answer different questions and a maintainer may only be right
     * about one of them. Somebody who knows `review` knows what a review skill must contain;
     * somebody who knows `legal` knows whether this particular one is wrong about the law.
     */
    axis: categoryAxis("axis").notNull(),
    /** A value from the vocabulary of that axis. Validated by the writer, which owns the list. */
    category: text("category").notNull(),

    /** Why this person. Read by the next admin deciding whether the group is still right. */
    note: text("note"),

    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    /**
     * One standing per person per category, live or lapsed.
     *
     * Re-granting therefore clears `revoked_at` on the existing row rather than writing a second
     * one — which keeps "when did this person first become a maintainer" answerable, and stops a
     * revoked row and a live row for the same pair existing at once, where every read would have
     * to pick one and two readers would eventually pick differently.
     */
    uniqueIndex("category_maintainers_uq").on(t.userId, t.axis, t.category),
    /** The membership lookup: who maintains this category right now. */
    index("category_maintainers_category_idx").on(t.axis, t.category, t.revokedAt),
    /** The authorisation lookup: which categories may this person act in. */
    index("category_maintainers_user_idx").on(t.userId, t.revokedAt),

    /**
     * Open to `app_runtime`, because a maintainer group is a **platform** role over the public
     * taxonomy and there is no tenant to scope it to — the same shape as `platform_settings` and
     * the open half of `mcp_tokens`.
     *
     * Safe because of the column list: a user id, an axis, a category, two timestamps and a note
     * an admin wrote about the appointment. RK.6 asks for *named* endorsement, so who maintains
     * what is a public fact by design. Granting is admin-only, and that is enforced in
     * `src/server/curation/maintainers.ts` rather than here — RLS has no concept of an admin.
     * Add a column carrying anything private and this policy becomes wrong.
     */
    pgPolicy("all_access", {
      for: "all",
      to: "app_runtime",
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/**
 * A maintainer vouching for one skill.
 *
 * ## The category is stored and the standing is not
 *
 * The row keeps which category the endorser was speaking as, because that pairing *is* the claim
 * — "endorsed by a maintainer of `review`" says something a bare count does not. Whether they
 * still hold it is resolved live, exactly as A4 resolves a supersession target and archetype
 * exemplars resolve their skills: somebody who has stopped maintaining `review` is no longer
 * vouching for review skills, and an endorsement that outlived the standing behind it would be a
 * claim nobody is making any more.
 *
 * ## Withdrawal blanks the row rather than deleting it
 *
 * The opposite decision from a rejected flag, and for the opposite reason. A refused report is
 * kept because it is a record of what somebody *else* claimed; an endorsement is the endorser's
 * own name on somebody's work, and continuing to display it after they took it back would be
 * putting words in their mouth. So `withdrawn_at` hides it from every read while the row — and
 * the `events` trail either side of it — stays.
 */
export const skillEndorsements = pgTable(
  "skill_endorsements",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Mirrors the skill's own scope, as everywhere else. Null is the public corpus. */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    /**
     * Which version was read.
     *
     * An endorsement is a statement about a document, and a re-sync can replace that document
     * underneath it. Recorded so a reader can be told the endorsement predates the current
     * version — the same `stale` label the flag queue carries, for the same reason: silently
     * carrying it forward would make a maintainer vouch for text they never saw.
     */
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** The standing they endorsed under. Meaningful only while `category_maintainers` agrees. */
    axis: categoryAxis("axis").notNull(),
    category: text("category").notNull(),

    /** One sentence of why. Optional, capped, and rendered as text — never as markup. */
    note: text("note"),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * One endorsement per person per skill.
     *
     * Not per version: endorsing again after a re-sync is the same person saying the same thing,
     * and counting it twice is the vote-stuffing R6.5 spends four defences on elsewhere. Re-
     * endorsing updates the version and the note on this row.
     */
    uniqueIndex("skill_endorsements_uq").on(t.skillId, t.userId),
    /** Every read: the live endorsements on one skill. */
    index("skill_endorsements_skill_idx").on(t.skillId, t.withdrawnAt),
    /** A maintainer's own list, for the settings panel. */
    index("skill_endorsements_user_idx").on(t.userId, t.at),

    /**
     * The `skill_relations` policy, and for the same reason: an endorsement on a private skill is
     * a fact about a customer's own corpus and must stay inside their tenant.
     */
    pgPolicy("org_scope", {
      for: "all",
      to: "app_runtime",
      using: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
